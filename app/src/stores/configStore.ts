// App-wide persisted configuration (zustand + localStorage).
//
// Model selections are keyed per language DIRECTION ("zh->en"), mirroring
// Sokuji's per-provider settings slice: flipping the direction keeps each
// direction's own ASR/MT/TTS picks. Everything else is global.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DisplayMode } from '../conversation/model';
import type { VoiceMode } from '../session/NativeSession';
import type { VadConfig } from '../session/NativeVad';
import type { NoiseMode } from '../audio/MicRecorder';

export interface DirModels {
  asrModel: string;
  trModel: string;
  ttsModel: string;
  ttsVoice: string;
  /** Voice source for TTS: built-in preset or cloned clip. Optional so
   *  persisted dirs from older versions need no migration ('preset' default). */
  voiceSource?: 'preset' | 'clone';
  /** Selected clip in the IndexedDB voice library (clone mode only). */
  cloneVoiceId?: number | null;
}

export interface AudioConfig {
  inputDeviceId: string;    // '' = system default mic
  outputDeviceId: string;   // '' = system default speaker
  noiseMode: NoiseMode;     // off / standard (RNNoise) / enhanced (GTCRN)
  passthrough: boolean;     // monitor own voice (raw, 30%)
  participantDeviceId: string; // their-audio source (loopback/VA cable), '' = unset
}

/** Sokuji's channel-mode selector: whose speech gets translated. */
export type ChannelMode = 'me' | 'other' | 'both';

export interface PanelConfig {
  open: boolean;   // settings panel visible
  width: number;   // px, drag-resized
}

export interface AppConfig {
  sourceLang: string;
  targetLang: string;
  dirs: Record<string, DirModels>;
  mode: VoiceMode;
  channelMode: ChannelMode;
  speak: boolean;
  volume: number;
  ttsSpeed: number;
  prompt: string;
  promptMode: 'simple' | 'advanced';
  vad: VadConfig;
  audio: AudioConfig;
  /** Hide Chromium's "Default -"/"Communications -" role-alias rows in the
   *  device lists (the 系统默认 first row already covers them). */
  compactDevices: boolean;
  panel: PanelConfig;
  display: { mode: DisplayMode; fontSize: number; compact: boolean };
}

export const dirKey = (src: string, dst: string) => `${src || 'auto'}->${dst}`;

export const EMPTY_DIR: DirModels = { asrModel: '', trModel: '', ttsModel: '', ttsVoice: '' };

const DEFAULTS: AppConfig = {
  sourceLang: 'zh',
  targetLang: 'en',
  dirs: {},
  mode: 'ptt',
  channelMode: 'me',
  speak: true,
  volume: 0.9,
  ttsSpeed: 1.0,
  prompt: '',
  promptMode: 'simple',
  // Sokuji's shipped local_native defaults (LocalNativeProviderConfig):
  // 1.4s silence keeps Chinese sentences whole; 0.35s shattered them.
  vad: { threshold: 0.3, minSilence: 1.4, minSpeech: 0.4 },
  audio: { inputDeviceId: '', outputDeviceId: '', noiseMode: 'off', passthrough: false, participantDeviceId: '' },
  compactDevices: true,
  panel: { open: true, width: 320 },
  display: { mode: 'both', fontSize: 16, compact: false },
};

interface ConfigStore extends AppConfig {
  patch(p: Partial<AppConfig>): void;
  patchDir(p: Partial<DirModels>): void;
  patchDisplay(p: Partial<AppConfig['display']>): void;
  patchVad(p: Partial<VadConfig>): void;
  patchAudio(p: Partial<AudioConfig>): void;
  patchPanel(p: Partial<PanelConfig>): void;
}

export const useConfig = create<ConfigStore>()(persist((set, get) => ({
  ...DEFAULTS,
  patch: (p) => set(p),
  patchDir: (p) => {
    const k = dirKey(get().sourceLang, get().targetLang);
    const cur = get().dirs[k] || EMPTY_DIR;
    set({ dirs: { ...get().dirs, [k]: { ...cur, ...p } } });
  },
  patchDisplay: (p) => set({ display: { ...get().display, ...p } }),
  patchVad: (p) => set({ vad: { ...get().vad, ...p } }),
  patchAudio: (p) => set({ audio: { ...get().audio, ...p } }),
  patchPanel: (p) => set({ panel: { ...get().panel, ...p } }),
}), { name: 'localtalk-config', version: 2, migrate: (p: unknown, v) => {
  // v0 storage predates audio.participantDeviceId / channelMode; shallow-merge
  // the slices that gained fields so existing users keep their settings.
  if (!p || typeof p !== 'object') return p as AppConfig;
  const s = p as Partial<AppConfig> & { audio?: Partial<AudioConfig> };
  let out: Partial<AppConfig> = s;
  if (v < 1) out = { ...s, channelMode: s.channelMode ?? 'me', audio: { ...DEFAULTS.audio, ...(s.audio || {}) } };
  // v2: v1 shipped vad 0.35s/0.3s, which shatters Chinese sentences into
  // fragments (see DEFAULTS note). Anyone still at/below those defaults gets
  // Sokuji's 1.4/0.4; deliberate tunings above are kept.
  if (v < 2 && out.vad) {
    const vad = out.vad;
    out = { ...out, vad: {
      ...vad,
      minSilence: (vad.minSilence ?? 1.4) <= 0.5 ? 1.4 : vad.minSilence,
      minSpeech: (vad.minSpeech ?? 0.4) < 0.4 ? 0.4 : vad.minSpeech,
    } };
  }
  return out as AppConfig;
} }));
