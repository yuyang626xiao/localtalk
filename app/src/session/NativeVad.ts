// Wrapper around the Silero VAD worker (ported from Sokuji LocalNativeClient's
// worker wiring, AGPL-3.0). The worker emits EDGE events only; the caller maps
// them to sidecar vad_mark frames. Audio is fed continuously (including
// silence) in BOTH auto and push-to-talk modes — the sidecar's 0.7 s preroll
// ring absorbs the ~0.1-0.3 s detection latency.

import { createNativeVadWorker } from './createNativeVadWorker';
import type { VadWebConfig } from '../workers/_shared/vadConfig';

export type VadEdge = 'start' | 'end' | 'cancel';

export interface VadConfig {
  threshold: number;       // positive speech threshold (0.1-0.95)
  minSilence: number;      // seconds of silence that closes a segment
  minSpeech: number;       // seconds of speech a segment needs, else misfire→cancel
}

/** Frames arrive at the rate declared in asr_init; this app standardizes on 24k. */
const VAD_AUDIO_SAMPLE_RATE = 24000;

export class NativeVad {
  onEdge: ((e: VadEdge) => void) | null = null;
  private worker: Worker | null = null;
  private ready = false;
  /** Mirrors the worker's FrameProcessor state: true between a start edge and
   *  the next end/cancel. PTT uses it to catch the race where speech (or a
   *  noise burst) opened a segment BEFORE the key window did — the gated
   *  start edge was dropped, so the session must open the sidecar segment
   *  itself on key-down or the whole utterance is lost. */
  private speaking = false;

  get isSpeaking(): boolean { return this.speaking; }

  /** Create the worker and wait for its model load. Throws on failure/timeout. */
  async init(cfg: VadConfig, timeoutMs = 15000): Promise<void> {
    this.dispose();
    this.speaking = false;
    const worker = createNativeVadWorker();
    this.worker = worker;
    const vadConfig: VadWebConfig = {
      threshold: cfg.threshold,
      minSilenceDuration: cfg.minSilence,
      minSpeechDuration: cfg.minSpeech,
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VAD 初始化超时')), timeoutMs);
        worker.onmessage = (ev: MessageEvent) => {
          const m = ev.data as { type: string; message?: string };
          switch (m.type) {
            case 'ready': clearTimeout(timer); resolve(); break;
            case 'speech_start': this.speaking = true; this.onEdge?.('start'); break;
            case 'speech_end': this.speaking = false; this.onEdge?.('end'); break;
            case 'speech_cancel': this.speaking = false; this.onEdge?.('cancel'); break;
            case 'error': clearTimeout(timer); reject(new Error(m.message || 'VAD error')); break;
          }
        };
        worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'VAD worker error')); };
        // Absolute URLs so this works from both http (dev) and file:// (packaged).
        worker.postMessage({
          type: 'init',
          ortWasmBaseUrl: new URL('./wasm/ort/', window.location.href).href,
          vadModelUrl: new URL('./wasm/vad/silero_vad_v5.onnx', window.location.href).href,
          vadConfig,
        });
      });
    } catch (e) {
      this.dispose();
      throw e;
    }
    this.ready = true;
  }

  feed(pcm: Int16Array): void {
    if (this.ready && this.worker) {
      // No transfer list: the same buffer goes to the WS binary frame first.
      this.worker.postMessage({ type: 'audio', pcm, sampleRate: VAD_AUDIO_SAMPLE_RATE });
    }
  }

  /** Force-close the current segment (PTT release / session stop). */
  flush(): void {
    if (this.ready) this.worker?.postMessage({ type: 'flush' });
  }

  dispose(): void {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'dispose' }); } catch { /* already dead */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
  }
}
