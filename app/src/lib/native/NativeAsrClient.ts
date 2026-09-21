// Ported from Sokuji src/lib/local-inference/native/NativeAsrClient.ts (AGPL-3.0, © Kizuna AI Lab).
//
// Wire facts (sidecar/sokuji_sidecar/asr_engine.py):
//   - binary frames on this connection = raw Int16 mono PCM at the sampleRate
//     declared in asr_init (the sidecar resamples to float32@16k itself);
//   - offline cards segment client-side via vad_mark {start|end|cancel};
//     streaming cards run a server-side pump, same marks own the endpoints;
//   - results arrive as id-less pushes: partial {text} … result {text,…}.

import type { ServerMsg } from './nativeProtocol';
import { SidecarConnection, INIT_REQUEST_TIMEOUT_MS, type ISidecarConnection } from './SidecarConnection';

export interface NativeAsrResult { text: string; startSample?: number; durationMs: number; recognitionTimeMs: number; }

export class NativeAsrClient {
  onResult: ((r: NativeAsrResult) => void) | null = null;
  onPartialResult: ((text: string) => void) | null = null;
  onStatus: ((m: string) => void) | null = null;
  onError: ((e: string) => void) | null = null;
  private conn: ISidecarConnection;

  constructor(conn: ISidecarConnection = new SidecarConnection()) {
    this.conn = conn;
    this.conn.onMessage((msg) => this.onPush(msg));
  }

  private onPush(msg: ServerMsg): void {
    if (msg.type === 'partial') { this.onPartialResult?.(msg.text); return; }
    if (msg.type === 'result') {
      this.onResult?.({ text: msg.text, startSample: msg.startSample, durationMs: msg.durationMs, recognitionTimeMs: msg.recognitionTimeMs });
      return;
    }
    // Feeder errors during streaming arrive id-less; an id-carrying error is a late
    // reply to an already-rejected timed-out request — don't surface it twice.
    if (msg.type === 'error' && (msg as { id?: number }).id === undefined) this.onError?.(msg.message);
  }

  async init(
    language = '', modelId?: string, sampleRate = 24000, device?: string, variant?: string,
  ): Promise<{ loadTimeMs: number; backend?: string; device?: string; computeType?: string; rtf?: number; memoryBytes?: number; fallbackReason?: string }> {
    this.onStatus?.('[native-asr] init…');
    const msg = await this.conn.request({
      type: 'asr_init', language, model: modelId, sampleRate, device, variant,
    }, { timeoutMs: INIT_REQUEST_TIMEOUT_MS });
    const r = msg as Extract<ServerMsg, { type: 'ready' }>;
    return { loadTimeMs: r.loadTimeMs, backend: r.backend, device: r.device, computeType: r.computeType, rtf: r.rtf, memoryBytes: r.memoryBytes, fallbackReason: r.fallbackReason };
  }

  feedAudio(samples: Int16Array, _sampleRate: number): void {
    this.conn.sendBinary(samples);   // pass the view so a subarray isn't over-sent
  }

  /** Forward a client-VAD edge to the sidecar (fire-and-forget; interleaves
   *  with the binary PCM in connection order). */
  sendVadMark(event: 'start' | 'end' | 'cancel'): void {
    this.conn.send({ type: 'vad_mark', event });
  }

  async flush(): Promise<void> { await this.conn.request({ type: 'asr_flush' }); }

  dispose(): void { this.conn.dispose(); }
}
