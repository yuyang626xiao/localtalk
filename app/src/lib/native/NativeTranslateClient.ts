// Ported from Sokuji src/lib/local-inference/native/NativeTranslateClient.ts (AGPL-3.0, © Kizuna AI Lab).
//
// translate_init also carries the co-loaded asr/tts model ids so the sidecar's
// VRAM ledger can reserve for them when placing the translation model.

import type { ServerMsg } from './nativeProtocol';
import { SidecarConnection, INIT_REQUEST_TIMEOUT_MS, type ISidecarConnection } from './SidecarConnection';

export interface NativeTranslationResult { sourceText: string; translatedText: string; inferenceTimeMs: number; }

export class NativeTranslateClient {
  onStatus: ((m: string) => void) | null = null;
  onError: ((e: string) => void) | null = null;
  /** Fires once per token during translate() generation, id-less push; text is
   *  the cleaned full accumulation so far, not a delta. */
  onPartial: ((text: string) => void) | null = null;
  private conn: ISidecarConnection;

  constructor(conn: ISidecarConnection = new SidecarConnection()) {
    this.conn = conn;
    this.conn.onMessage((msg) => this.onPush(msg));
  }

  private onPush(msg: ServerMsg): void {
    if (msg.type === 'translate_partial') { this.onPartial?.(msg.text); return; }
    if (msg.type === 'error' && (msg as { id?: number }).id === undefined) this.onError?.(msg.message);
  }

  async init(
    sourceLang: string, targetLang: string, modelId?: string, device?: string,
    asrModel?: string | null, ttsModel?: string | null, variant?: string,
  ): Promise<{ loadTimeMs: number; backend?: string; device?: string; computeType?: string; tokensPerSec?: number; memoryBytes?: number; fallbackReason?: string }> {
    this.onStatus?.('[native-translate] init…');
    const payload: Record<string, unknown> = { type: 'translate_init', sourceLang, targetLang, model: modelId, device };
    if (asrModel) payload.asrModel = asrModel;
    if (ttsModel) payload.ttsModel = ttsModel;
    if (variant) payload.variant = variant;
    const msg = await this.conn.request(payload as { type: string; [k: string]: unknown }, { timeoutMs: INIT_REQUEST_TIMEOUT_MS });
    const r = msg as Extract<ServerMsg, { type: 'ready' }>;
    return { loadTimeMs: r.loadTimeMs, backend: r.backend, device: r.device, computeType: r.computeType, tokensPerSec: r.tokensPerSec, memoryBytes: r.memoryBytes, fallbackReason: r.fallbackReason };
  }

  async translate(text: string, systemPrompt = '', wrapTranscript = false): Promise<NativeTranslationResult> {
    const msg = await this.conn.request({ type: 'translate', text, systemPrompt, wrapTranscript }) as Extract<ServerMsg, { type: 'translate_result' }>;
    return { sourceText: msg.sourceText, translatedText: msg.translatedText, inferenceTimeMs: msg.inferenceTimeMs };
  }

  dispose(): void { this.conn.dispose(); }
}
