// The pipeline brain: mic PCM → ASR (VAD-driven segment marks) → translate
// (serial queue, partials streamed) → TTS (chunked, played as it synthesizes).
//
// Two voice modes share ONE mark source, mirroring Sokuji's LocalNativeClient:
//   auto — recorder runs for the whole session; Silero VAD edges drive marks.
//   ptt  — recorder runs while held; release feeds a 700 ms silence tail then
//          double-flushes (worker flush + asr_flush, both idempotent). If the
//          VAD failed to initialize, ptt falls back to manual start/end marks.
//
// Each stage client owns its own WS connection — that is the sidecar's contract
// (per-connection binary routing + per-connection VRAM teardown).

import { NativeAsrClient } from '../lib/native/NativeAsrClient';
import { NativeTranslateClient } from '../lib/native/NativeTranslateClient';
import { NativeTtsClient } from '../lib/native/NativeTtsClient';
import { SidecarConnection, type SidecarLane } from '../lib/native/SidecarConnection';
import type { VoiceApplyPayload } from '../lib/native/nativeVoiceStores';
import { NativeVad, type VadConfig } from './NativeVad';
import { MicRecorder, type NoiseMode } from '../audio/MicRecorder';
import { PcmPlayer } from '../audio/PcmPlayer';

export type VoiceMode = 'auto' | 'ptt';

export interface SessionConfig {
  /** Which sidecar process this pipeline talks to: 'speaker' = my mic lane,
   *  'participant' = their-audio lane (reverse direction, VAD-only, no TTS). */
  lane?: SidecarLane;
  sourceLang: string;        // '' = multilingual/auto where the card supports it
  targetLang: string;
  asrModel?: string;
  translateModel?: string;
  ttsModel?: string;
  ttsVoice?: string;         // preset name; omitted for families that speak voiceless
  /** Zero-shot clone: reference clip applied instead of any preset name.
   *  Takes precedence over ttsVoice when present. */
  ttsClone?: VoiceApplyPayload;
  speak: boolean;            // synthesize + play the translation
  mode: VoiceMode;
  vad: VadConfig;
  translatePrompt?: string;  // custom system prompt ('' = model default)
  ttsSpeed?: number;         // 0.5-2.0, default 1.0
  audio?: {
    inputDeviceId?: string;    // '' = system default mic
    outputDeviceId?: string;   // '' = system default speaker (TTS + passthrough)
    noiseMode?: NoiseMode;     // off / standard (RNNoise) / enhanced (GTCRN)
    passthrough?: boolean;     // monitor own voice (raw, 30%)
  };
}

export interface StageInfo { label: string; detail: string; memoryBytes?: number; }

export interface SessionEvents {
  onStatus?(m: string): void;
  onSourcePartial?(t: string): void;
  /** ASR final for a segment — fires immediately at recognition time, before
   *  translation, so the source row can settle while the mic keeps capturing
   *  the NEXT segment (auto mode runs ahead of the translate pump). */
  onSourceFinal?(t: string): void;
  onTranslated?(src: string, dst: string, ms: number): void;
  onTranslatePartial?(t: string): void;
  onError?(e: string): void;
  onStages?(s: StageInfo[]): void;
}

const ASR_RATE = 24000;
/** Sokuji pttFinalization.silenceTailFrames=7 × 100 ms — Silero needs the tail
 *  to confirm the segment end on its own before the forced flush. */
const SILENCE_TAIL_SAMPLES = Math.round(0.7 * ASR_RATE);

/** Voice-preview sample in the session's TARGET language (a clone judged on
 *  wrong-language phonetics misleads; fall back to en for unlisted langs). */
const PREVIEW_TEXTS: Record<string, string> = {
  zh: '你好，这是我的声音效果。',
  en: 'Hello, this is how my voice sounds.',
  ja: 'こんにちは、これが私の声です。',
  ko: '안녕하세요, 이것이 제 목소리입니다.',
  fr: 'Bonjour, voici à quoi ma voix ressemble.',
  de: 'Hallo, so klingt meine Stimme.',
  es: 'Hola, así suena mi voz.',
  ru: 'Привет, вот как звучит мой голос.',
};
export function previewText(lang: string): string {
  return PREVIEW_TEXTS[lang] || PREVIEW_TEXTS.en;
}

export class NativeSession {
  readonly asr: NativeAsrClient;
  readonly translate: NativeTranslateClient;
  readonly tts: NativeTtsClient;
  readonly player = new PcmPlayer();
  private recorder = new MicRecorder();
  private vad = new NativeVad();
  private vadOk = false;
  private ev: SessionEvents;
  private cfg: SessionConfig;
  private stages: StageInfo[] = [];

  prepared = false;
  /** Mic currently streaming into ASR+VAD (session open; both modes). */
  micOpen = false;
  /** PTT key window — the segment gate inside an open ptt session. */
  private pttWindow = false;
  get pttHeld(): boolean { return this.pttWindow; }

  private queue: string[] = [];
  private pumping = false;
  /** Bumped on every ASR result — lets pttUp detect "flush closed nothing". */
  private resultTick = 0;

  constructor(cfg: SessionConfig, ev: SessionEvents) {
    this.cfg = cfg;
    this.ev = ev;
    // One socket per stage, all bound to this lane's sidecar process.
    this.asr = new NativeAsrClient(new SidecarConnection(cfg.lane));
    this.translate = new NativeTranslateClient(new SidecarConnection(cfg.lane));
    this.tts = new NativeTtsClient(new SidecarConnection(cfg.lane));

    this.asr.onStatus = (m) => this.ev.onStatus?.(m);
    this.asr.onError = (e) => this.ev.onError?.(e);
    this.asr.onPartialResult = (t) => this.ev.onSourcePartial?.(t);
    this.asr.onResult = (r) => {
      const text = r.text.trim();
      if (!text) return;
      this.resultTick++;
      this.ev.onSourceFinal?.(text);
      this.queue.push(text);
      void this.pump();
    };

    this.translate.onStatus = (m) => this.ev.onStatus?.(m);
    this.translate.onError = (e) => this.ev.onError?.(e);
    this.translate.onPartial = (t) => this.ev.onTranslatePartial?.(t);

    this.tts.onStatus = (m) => this.ev.onStatus?.(m);
    this.tts.onError = (e) => this.ev.onError?.(e);
  }

  /** Load all three engines (each on its own socket) + the VAD worker. */
  async prepare(): Promise<void> {
    if (this.prepared) return;
    const { sourceLang, targetLang, asrModel, translateModel, ttsModel, ttsVoice } = this.cfg;
    this.ev.onStatus?.('加载 ASR 模型…（首次加载可能较慢）');
    const a = await this.asr.init(sourceLang, asrModel, ASR_RATE);
    this.pushStage('ASR', `${a.device || a.backend || 'ok'} · ${(a.loadTimeMs / 1000).toFixed(1)}s`, a.memoryBytes);
    this.ev.onStatus?.('加载翻译模型…');
    const t = await this.translate.init(sourceLang, targetLang, translateModel, undefined, asrModel, ttsModel);
    this.pushStage('翻译', `${t.device || t.backend || 'ok'} · ${(t.loadTimeMs / 1000).toFixed(1)}s`, t.memoryBytes);
    if (this.cfg.speak && ttsModel) {
      this.ev.onStatus?.('加载 TTS 模型…');
      const s = await this.tts.init(ttsModel, undefined, targetLang);
      if (this.cfg.ttsClone) {
        const c = this.cfg.ttsClone;
        await this.tts.setReferenceVoice(c.audio, c.sampleRate, c.transcript);
      } else if (ttsVoice) await this.tts.setVoice(ttsVoice);
      this.pushStage('TTS', `${s.device || s.backend || 'ok'} · ${(s.loadTimeMs / 1000).toFixed(1)}s`, s.memoryBytes);
    }
    // VAD: one mark source for both modes. Auto mode is useless without it;
    // ptt can survive on manual marks.
    this.ev.onStatus?.('初始化 VAD…');
    try {
      await this.vad.init(this.cfg.vad);
      // PTT mode runs with the mic open (session model): VAD may only OPEN a
      // segment while the key window is held; end edges always pass (closing a
      // segment that never opened is a no-op engine-side).
      this.vad.onEdge = (e) => {
        if (e === 'start' && this.cfg.mode === 'ptt' && !this.pttWindow) return;
        this.asr.sendVadMark(e);
      };
      this.vadOk = true;
      this.pushStage('VAD', `阈值 ${this.cfg.vad.threshold.toFixed(2)} · 静音 ${this.cfg.vad.minSilence.toFixed(2)}s`);
    } catch (e) {
      this.vadOk = false;
      if (this.cfg.mode === 'auto') {
        throw new Error(`自动模式需要 VAD：${e instanceof Error ? e.message : String(e)}`);
      }
      this.ev.onStatus?.('VAD 不可用，按住说话改用手动切段');
    }
    this.prepared = true;
    if (this.cfg.audio?.outputDeviceId) await this.player.setSinkId(this.cfg.audio.outputDeviceId);
    this.ev.onStatus?.('引擎就绪');
  }

  private pushStage(label: string, detail: string, memoryBytes?: number): void {
    this.stages = [...this.stages.filter((s) => s.label !== label), { label, detail, memoryBytes }];
    this.ev.onStages?.(this.stages);
  }

  private async openMic(): Promise<void> {
    if (this.micOpen) return;
    const a = this.cfg.audio || {};
    await this.recorder.start((i16) => {
      this.asr.feedAudio(i16, ASR_RATE);
      if (this.vadOk) this.vad.feed(i16);
    }, ASR_RATE, {
      deviceId: a.inputDeviceId || undefined,
      noiseMode: a.noiseMode || 'off',
      passthrough: a.passthrough,
      outputSinkId: a.outputDeviceId || undefined,
    });
    this.micOpen = true;
  }

  // ── session (Sokuji model: 开始会话 = engine + mic live in BOTH modes) ────

  async startSession(): Promise<void> {
    if (this.micOpen) return;
    if (!this.prepared) await this.prepare();
    this.player.interrupt();
    await this.openMic();
    this.ev.onStatus?.(this.cfg.mode === 'auto' ? '聆听中…（自动分段）' : '会话就绪：按住说话（或空格）');
  }

  async stopSession(): Promise<void> {
    if (!this.micOpen) return;
    if (this.pttWindow) this.pttWindow = false;   // finishSegment below closes it
    await this.closeMicAndFinish();
    this.ev.onStatus?.('已停止拾音');
  }

  // ── push-to-talk: a segment gate INSIDE an open session ──────────────────

  /** Press: open the key window. With VAD the segment opens on speech onset
   *  (preroll ring absorbs the latency); without it, mark manually.
   *  Requires 开始会话 first — the mic stays open for the whole session. */
  async pttDown(): Promise<void> {
    if (this.pttWindow || !this.micOpen) return;
    this.player.interrupt();
    this.pttWindow = true;
    // No VAD: open the segment manually. With VAD: if the worker is ALREADY
    // mid-speech (onset or a noise burst fired before this key-down, and the
    // gated start edge was dropped), open the segment now — otherwise the
    // sidecar never sees a start mark and the whole utterance is lost.
    if (!this.vadOk) this.asr.sendVadMark('start');
    else if (this.vad.isSpeaking) this.asr.sendVadMark('start');
    this.ev.onStatus?.('聆听中…');
  }

  /** Release: silence tail + double flush closes the segment (mic stays open). */
  async pttUp(): Promise<void> {
    if (!this.pttWindow) return;
    this.ev.onStatus?.('识别中…');
    const tick = this.resultTick;
    await this.finishSegment();
    // The offline engine sends its result BEFORE the flush reply, so nothing
    // new by now means the segment never opened or was a misfire — say so
    // instead of hanging on 识别中 forever.
    if (this.resultTick === tick) this.ev.onStatus?.('未识别到语音（太短、太轻，或开口早于按键）');
  }

  /** Close the in-flight segment: tail + VAD flush + asr_flush backstop.
   *  Safe when nothing was spoken (both flushes are idempotent). */
  private async finishSegment(): Promise<void> {
    this.pttWindow = false;
    if (this.vadOk) {
      const tail = new Int16Array(SILENCE_TAIL_SAMPLES); // zeros
      this.asr.feedAudio(tail, ASR_RATE);
      this.vad.feed(tail);
      this.vad.flush();
    }
    this.asr.flush().catch(() => { /* segment was already closed */ });
  }

  /** Close the mic and cleanly finish any in-flight segment (idempotent flush). */
  private async closeMicAndFinish(): Promise<void> {
    if (!this.micOpen) return;
    this.micOpen = false;
    await this.recorder.stop();          // flush arrives as binary frames
    await this.finishSegment();
  }

  abort(): void {
    this.pttWindow = false;
    if (this.micOpen) {
      this.micOpen = false;
      void this.recorder.stop().then(() => this.asr.sendVadMark('cancel'));
    }
    this.queue.length = 0;
    this.tts.cancel();
    this.player.interrupt();
  }

  /** Serial pump: translate + (optionally) speak each finished ASR segment. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const src = this.queue.shift()!;
        const r = await this.translate.translate(src, this.cfg.translatePrompt || '');
        const dst = r.translatedText.trim();
        this.ev.onTranslated?.(r.sourceText, dst, r.inferenceTimeMs);
        if (this.cfg.speak && dst) {
          this.ev.onStatus?.('合成语音…');
          await this.tts.generate(dst, this.cfg.ttsSpeed ?? 1.0, (pcm) => this.player.play(pcm));
        }
      }
      this.ev.onStatus?.(this.micOpen
        ? (this.cfg.mode === 'ptt' ? '会话就绪：按住说话（或空格）' : '聆听中…（自动分段）')
        : '引擎就绪');
    } catch (e) {
      this.queue.length = 0;
      this.ev.onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      this.pumping = false;
    }
  }

  setSpeak(on: boolean): void { this.cfg.speak = on; if (!on) { this.tts.cancel(); this.player.interrupt(); } }
  setVolume(v: number): void { this.player.volume = v; }
  /** Control-bar input meter (0..1); 0 while the mic is closed. */
  micLevel(): number { return this.micOpen ? this.recorder.level() : 0; }
  /** Live knobs read per-use by the pump — no engine reload needed. */
  setPrompt(p: string): void { this.cfg.translatePrompt = p; }
  setSpeed(v: number): void { this.cfg.ttsSpeed = v; }
  /** Audio knobs: applied to the live graph where possible (noise mode only
   *  takes effect mid-capture if the mic is open; device changes apply on
   *  the next openMic, mirroring Sokuji's restart-on-switch semantics). */
  async setNoiseMode(m: NoiseMode): Promise<void> {
    (this.cfg.audio ||= {}).noiseMode = m;
    if (this.micOpen) await this.recorder.setNoiseMode(m);
  }
  setPassthrough(on: boolean): void {
    (this.cfg.audio ||= {}).passthrough = on;
    this.recorder.setPassthrough(on);
  }
  async setOutputDevice(id: string): Promise<void> {
    (this.cfg.audio ||= {}).outputDeviceId = id;
    await this.player.setSinkId(id);
    await this.recorder.setSinkId(id);
  }

  /** Live voice swap (preset name ⇄ clone clip) — the engine is already
   *  loaded, so this is one set_voice round-trip, no reload. */
  async applyVoice(v: { clone?: VoiceApplyPayload; preset?: string }): Promise<void> {
    if (!this.prepared || !(this.cfg.speak && this.cfg.ttsModel)) return;
    if (v.clone) {
      this.cfg.ttsClone = v.clone; this.cfg.ttsVoice = undefined;
      await this.tts.setReferenceVoice(v.clone.audio, v.clone.sampleRate, v.clone.transcript);
    } else if (v.preset) {
      this.cfg.ttsClone = undefined; this.cfg.ttsVoice = v.preset;
      await this.tts.setVoice(v.preset);
    }
  }

  /** Synthesize one fixed sample with the CURRENT voice through the session's
   *  output — the user's "does this clone sound right?" check. */
  async preview(): Promise<void> {
    if (!this.prepared || !(this.cfg.speak && this.cfg.ttsModel)) throw new Error('TTS 未加载');
    await this.tts.generate(previewText(this.cfg.targetLang), this.cfg.ttsSpeed ?? 1.0,
      (pcm) => this.player.play(pcm));
  }

  dispose(): void {
    this.recorder.dispose();   // full teardown incl. the persistent GTCRN worker
    this.micOpen = false;
    this.vad.dispose();
    this.asr.dispose();
    this.translate.dispose();
    this.tts.dispose();
    this.player.close();
    this.prepared = false;
  }
}
