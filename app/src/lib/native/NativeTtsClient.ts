// Ported from Sokuji src/lib/local-inference/native/NativeTtsClient.ts (AGPL-3.0, © Kizuna AI Lab).
//
// The sidecar streams TTS PCM as Int16 mono @ 24 kHz; each `tts_chunk` JSON is
// preceded by its binary frame on the same connection (see server.py's
// send(binary-then-obj) funnel), so we stash the last binary and pair it with
// the chunk meta that follows.

import type { ServerMsg } from './nativeProtocol';
import { SidecarConnection, INIT_REQUEST_TIMEOUT_MS, SidecarTimeoutError, type ISidecarConnection } from './SidecarConnection';

export interface NativeTtsResult { samples: Float32Array; sampleRate: number; generationTimeMs: number; }

/** Reject a streaming generate if no chunk/done arrives for this long (inactivity). */
const TTS_STREAM_INACTIVITY_MS = 30_000;
/** Floor for a synthesis budget: what every generate got before the budget existed. */
const TTS_MIN_BUDGET_MS = 30_000;
/** Ceiling, so a genuinely wedged sidecar still fails as a timeout, not forever. */
const TTS_MAX_BUDGET_MS = 300_000;
/** Rough speech rate to turn text length into expected audio duration.
 *  Deliberately low (slower estimate = more headroom); the safety factor absorbs the rest. */
const CHARS_PER_SECOND_OF_SPEECH = 12;
/** Multiplier on the estimate, covering RTF measured on a different sentence and a busier box. */
const TTS_BUDGET_SAFETY = 2;
/** Assumed RTF when the sidecar reported none: the slowest family measured on CPU
 *  (index_tts2, 7.87), so an unknown model is budgeted like the worst known one. */
const TTS_ASSUMED_RTF = 8;

function int16ToFloat32(buf: ArrayBuffer): Float32Array {
  const i16 = new Int16Array(buf);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

export interface TtsReady {
  sampleRate: number; loadTimeMs: number;
  backend?: string; device?: string; computeType?: string; rtf?: number;
  streaming: boolean; clones: boolean; memoryBytes?: number; fallbackReason?: string;
  family?: string;
}

interface StreamDone { resolve: (m: ServerMsg) => void; reject: (e: Error) => void; bump: () => void; }

export class NativeTtsClient {
  onStatus: ((m: string) => void) | null = null;
  onError: ((e: string) => void) | null = null;
  private conn: ISidecarConnection;
  private lastBinary: ArrayBuffer | null = null;
  private streamHandlers = new Map<number, (pcm: Float32Array, seq: number) => void>();
  private streamDone = new Map<number, StreamDone>();
  private streaming = false;          // cached from the last init()
  private sampleRate = 24000;         // cached from the last init() (sidecar's PCM rate)
  private rtf = 0;                    // cached from the last init(); 0 = none reported
  private inFlightId = 0;

  constructor(conn: ISidecarConnection = new SidecarConnection()) {
    this.conn = conn;
    this.conn.onBinary((buf) => { this.lastBinary = buf; });
    this.conn.onMessage((msg) => this.onPush(msg));
    this.conn.onClose((err) => this.rejectStreams(err));
  }

  private onPush(msg: ServerMsg): void {
    const id = (msg as { id?: number }).id;
    if (msg.type === 'tts_chunk') {
      this.streamDone.get(id as number)?.bump();
      const onChunk = this.streamHandlers.get(id as number);
      if (onChunk && this.lastBinary) { onChunk(int16ToFloat32(this.lastBinary), msg.seq); this.lastBinary = null; }
      return;
    }
    if (msg.type === 'tts_done') {
      this.streamHandlers.delete(id as number);
      const d = this.streamDone.get(id as number);
      this.streamDone.delete(id as number);
      d?.resolve(msg);
      return;
    }
    if (msg.type === 'error') {
      if (typeof id === 'number' && this.streamDone.has(id)) {
        const d = this.streamDone.get(id)!;
        this.streamDone.delete(id); this.streamHandlers.delete(id);
        d.reject(new Error(msg.message));
      } else {
        this.onError?.(msg.message);
      }
      return;
    }
  }

  private rejectStreams(err: Error): void {
    for (const d of this.streamDone.values()) d.reject(err);
    this.streamDone.clear(); this.streamHandlers.clear(); this.lastBinary = null;
  }

  async init(model?: string, device?: string, language?: string, variant?: string): Promise<TtsReady> {
    this.onStatus?.('[native-tts] init…');
    // language = the session's target language; frontends that branch per-language
    // need it, and omitting it sent zh/ja text through the English G2P → silent.
    const msg = await this.conn.request({ type: 'tts_init', model, device, language, variant }, { timeoutMs: INIT_REQUEST_TIMEOUT_MS });
    const r = msg as Extract<ServerMsg, { type: 'ready' }>;
    this.streaming = !!r.streaming;
    this.sampleRate = r.sampleRate ?? 24000;
    this.rtf = typeof r.rtf === 'number' && r.rtf > 0 ? r.rtf : 0;
    return {
      sampleRate: this.sampleRate, loadTimeMs: r.loadTimeMs,
      backend: r.backend, device: r.device, computeType: r.computeType, rtf: r.rtf,
      streaming: !!r.streaming, clones: !!r.clones, memoryBytes: r.memoryBytes, fallbackReason: r.fallbackReason,
      family: r.family,
    };
  }

  /** Select a built-in voice by name (applies to subsequent generate calls). */
  async setVoice(name: string): Promise<void> { await this.conn.request({ type: 'set_voice', voice: name }); }

  async setReferenceVoice(audio: Float32Array, sampleRate: number, refText?: string): Promise<void> {
    this.conn.sendBinary(audio);   // binary frame precedes the control message
    await this.conn.request({ type: 'set_voice', sampleRate, ...(refText ? { refText } : {}) });
  }

  /** How long this synthesis may take before the renderer stops waiting. */
  private budgetMs(text: string): number {
    const estimatedAudioS = Math.max(1, text.length / CHARS_PER_SECOND_OF_SPEECH);
    const rtf = this.rtf > 0 ? this.rtf : TTS_ASSUMED_RTF;
    const budget = estimatedAudioS * rtf * TTS_BUDGET_SAFETY * 1000;
    return Math.min(TTS_MAX_BUDGET_MS, Math.max(TTS_MIN_BUDGET_MS, Math.round(budget)));
  }

  async generate(text: string, speed = 1.0, onChunk?: (pcm: Float32Array, seq: number) => void): Promise<NativeTtsResult> {
    if (this.streaming && onChunk) {
      const id = this.conn.nextId();
      this.inFlightId = id;
      this.streamHandlers.set(id, onChunk);
      const firstChunkMs = this.budgetMs(text);
      const done = await new Promise<ServerMsg>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const clear = () => clearTimeout(timer);
        const arm = (ms: number = TTS_STREAM_INACTIVITY_MS) => { timer = setTimeout(() => {
          this.streamDone.delete(id); this.streamHandlers.delete(id);
          reject(new SidecarTimeoutError('tts_generate', ms));
        }, ms); };
        arm(firstChunkMs);   // the first wait IS the whole synthesis for a cpu-only family
        this.streamDone.set(id, {
          resolve: (m) => { clear(); resolve(m); },
          reject: (e) => { clear(); reject(e); },
          bump: () => { clear(); arm(); },   // between chunks: back to the tight allowance
        });
        this.conn.send({ type: 'tts_generate', text, speed, id });
      });
      const d = done as Extract<ServerMsg, { type: 'tts_done' }>;
      return { samples: new Float32Array(0), sampleRate: this.sampleRate, generationTimeMs: d.generationTimeMs };
    }
    // One-shot: the sidecar sends the PCM binary frame, then the result meta.
    const id = this.conn.nextId();
    this.inFlightId = id;
    this.lastBinary = null;
    const msg = await this.conn.request({ type: 'tts_generate', text, speed }, { id, timeoutMs: this.budgetMs(text) });
    const binary = this.lastBinary; this.lastBinary = null;
    // Verified, not cast: the SIDECAR picks streaming vs one-shot off the loaded
    // engine, so a streaming family resolves this with a `tts_chunk` (no sampleRate).
    if (msg.type !== 'tts_generate_result') {
      throw new Error(
        `tts_generate resolved with '${msg.type}', not 'tts_generate_result' — `
        + 'this family streams; pass an onChunk callback to generate()',
      );
    }
    if (!binary) throw new Error('tts_generate sent no audio frame');
    return { samples: int16ToFloat32(binary), sampleRate: msg.sampleRate, generationTimeMs: msg.generationTimeMs };
  }

  cancel(): void {
    if (this.inFlightId) this.conn.send({ type: 'tts_cancel', id: this.inFlightId });
  }

  dispose(): void {
    this.rejectStreams(new Error('native host disconnected'));
    this.conn.dispose();
  }
}
