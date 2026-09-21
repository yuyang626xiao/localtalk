// Ported from Sokuji src/lib/local-inference/native/SidecarConnection.ts (AGPL-3.0, © Kizuna AI Lab).
//
// The WS-RPC transport seam to the Python sidecar. One instance owns one socket.
// Each stage client (ASR / translate / TTS / model-management) holds its OWN
// connection: the sidecar routes binary frames and frees VRAM per connection.

import type { ServerMsg } from './nativeProtocol';

/** Session/management RPCs should be fast; a hang is a bug. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Model load is legitimately slow; bound it so a wedged load surfaces an error. */
export const INIT_REQUEST_TIMEOUT_MS = 120_000;

export class SidecarTimeoutError extends Error {
  constructor(public readonly requestType: string, public readonly timeoutMs: number) {
    super(`sidecar request '${requestType}' timed out after ${timeoutMs}ms`);
    this.name = 'SidecarTimeoutError';
  }
}

export interface ISidecarConnection {
  connect(): Promise<void>;
  request(payload: { type: string; [k: string]: unknown }, opts?: { timeoutMs?: number; id?: number }): Promise<ServerMsg>;
  send(payload: object): void;
  sendBinary(buf: ArrayBuffer | ArrayBufferView): void;
  nextId(): number;
  onMessage(cb: (msg: ServerMsg) => void): void;
  onBinary(cb: (buf: ArrayBuffer) => void): void;
  onClose(cb: (err: Error) => void): void;
  dispose(): void;
}

interface ElectronInvoke { invoke(channel: string, data?: unknown): Promise<any>; }
function electron(): ElectronInvoke {
  const e = (window as unknown as { electron?: ElectronInvoke }).electron;
  if (!e) throw new Error('window.electron is unavailable (not running in Electron)');
  return e;
}

interface Pending {
  resolve: (m: ServerMsg) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export type SidecarLane = 'speaker' | 'participant';

export class SidecarConnection implements ISidecarConnection {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  private counter = 0;
  private pending = new Map<number, Pending>();
  private messageCb: ((msg: ServerMsg) => void) | null = null;
  private binaryCb: ((buf: ArrayBuffer) => void) | null = null;
  private closeCb: ((err: Error) => void) | null = null;

  /** Which python sidecar process serves this socket. The engines are process
   *  singletons, so the two translation lanes need one process each. */
  constructor(private readonly lane: SidecarLane = 'speaker') {}

  nextId(): number { return ++this.counter; }
  onMessage(cb: (msg: ServerMsg) => void): void { this.messageCb = cb; }
  onBinary(cb: (buf: ArrayBuffer) => void): void { this.binaryCb = cb; }
  onClose(cb: (err: Error) => void): void { this.closeCb = cb; }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('native host disconnected');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    // Single-flight: the sidecar can take seconds to boot on first use; concurrent
    // callers must await the SAME attempt, else orphaned sockets race and reject
    // everyone's in-flight requests.
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async _connect(): Promise<void> {
    const r = await electron().invoke('native-host:start', { lane: this.lane });
    if (!r?.ok) throw new Error(r?.error || 'failed to start native host');
    if (this.disposed) throw new Error('native host disconnected');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (this.disposed) { try { ws.close(); } catch (_) { /* already closing */ } reject(new Error('native host disconnected')); return; }
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => reject(new Error('native host WS error'));
      ws.onclose = () => {
        reject(new Error('native host disconnected'));
        if (this.ws !== ws) return; // a stale socket must not tear down the live one
        this.ws = null;
        const err = new Error('native host disconnected');
        this.rejectAllPending(err);
        this.closeCb?.(err);
      };
      ws.onmessage = (e) => this.onSocketMessage(e.data);
    });
  }

  private onSocketMessage(data: any): void {
    if (data instanceof ArrayBuffer) { this.binaryCb?.(data); return; }
    const msg = JSON.parse(data) as ServerMsg;
    const id = (msg as { id?: number }).id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.type === 'error') p.reject(new Error((msg as { message: string }).message));
      else p.resolve(msg);
      return;
    }
    // Un-correlated: id-less pushes, model-keyed downloads, streaming frames.
    this.messageCb?.(msg);
  }

  request(payload: { type: string; [k: string]: unknown }, opts?: { timeoutMs?: number; id?: number }): Promise<ServerMsg> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return this.connect().then(() => new Promise<ServerMsg>((resolve, reject) => {
      const id = opts?.id ?? this.nextId();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('native host disconnected')); return; }
      const timer = timeoutMs > 0
        ? setTimeout(() => { if (this.pending.delete(id)) reject(new SidecarTimeoutError(payload.type, timeoutMs)); }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...payload, id }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }));
  }

  send(payload: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  sendBinary(buf: ArrayBuffer | ArrayBufferView): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAllPending(new Error('native host disconnected'));
    if (this.ws) { this.ws.onclose = null; this.ws.onmessage = null; try { this.ws.close(); } catch (_) { /* already closing */ } }
    this.ws = null;
  }
}
