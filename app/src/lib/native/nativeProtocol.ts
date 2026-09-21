// Ported verbatim (comments trimmed) from Sokuji src/lib/local-inference/native/nativeProtocol.ts
// (AGPL-3.0, © Kizuna AI Lab). Personal/internal use.
//
// WS message contract between the renderer and the python sidecar
// (TTS, translation, ASR, model management, hardware info).

export interface ReadyMsg {
  type: 'ready'; id: number; sampleRate?: number; loadTimeMs: number;
  backend?: string; device?: string; computeType?: string; rtf?: number; tokensPerSec?: number; memoryBytes?: number; fallbackReason?: string;
  streaming?: boolean; clones?: boolean;
  family?: string;   // native_tts only: the resolved card's family
}
export interface NativeTier { tier: string; backend: string; available: boolean; }
export interface NativeModelLicense {
  spdx: string; name: string; url: string;
  nonCommercial: boolean;
  requiresConsent?: boolean;
  sourceRepo: string; attribution: string;
}
export interface NativeModelInfo {
  id: string; name: string; languages: string[]; recommended: boolean; tiers: NativeTier[];
  order: number; repo: string; kind: 'asr' | 'translate' | 'tts';
  clones?: boolean; streaming?: boolean;   // tts only
  voice?: { builtin: 'none' | 'named'; custom: 'none' | 'clip'; required?: boolean; transcriptRequired?: boolean };
  license?: NativeModelLicense;
  sizeBytes?: number;   // total download size; 0/absent = unknown
  variantIds?: string[];
  variants?: { id: string; sizeBytes: number; needBytes?: number; repo?: string;
               supported: boolean; recommended: boolean; downloaded: boolean;
               unsupportedTiers?: string[] }[];
  deviceMemBytes?: number | null;
}
export interface NativeVoiceInfo {
  name: string; language?: string; curated: boolean; unstable: boolean; default: boolean;
}
export interface NativeDeviceProfile {
  index: number; kind: string; name: string; description: string; memTotalMb: number;
  known: boolean; features: string[]; driverName: string; driverVersion: string; deviceUuid: string;
  cpuFeatures: string;
  opCoverage: Record<string, { allSupported: boolean; unsupported: string[] }>;
}
export interface HardwareInfoResultMsg {
  type: 'hardware_info_result'; id: number;
  os: string; arch: string; cpuCores: number;
  gpus: { vendor: string; name: string; vramMb: number }[];
  backendsInstalled: string[]; accelAvailable: boolean;
  nativeVersion?: string | null;
  engineVersions?: Record<string, string> | null;
  lane?: string | null;
  preferredDevice?: { kind: string; name: string; description: string } | null;
  generation?: string | null;
  devices?: NativeDeviceProfile[] | null;
}
export interface ModelsCatalogResultMsg {
  type: 'models_catalog_result'; id: number; models: NativeModelInfo[];
}
export interface VariantInfo {
  id: string;
  computeType: string;
  repo: string;
  sizeBytes: number;
  supported: boolean;
  reason: string;
  unsupportedTiers?: string[];
  downloaded: boolean;
}
export interface ListVariantsResultMsg {
  type: 'list_variants_result'; id: number; variants: VariantInfo[]; recommended: string;
}
export interface OkMsg { type: 'ok'; id: number; }
export interface TtsGenerateResultMsg { type: 'tts_generate_result'; id: number; sampleRate: number; generationTimeMs: number; samples: number; }
export interface ErrorMsg { type: 'error'; id?: number; model?: string; message: string; }
export interface TranslateResultMsg { type: 'translate_result'; id: number; sourceText: string; translatedText: string; inferenceTimeMs: number; }
/** Id-less push during translate() generation: one per token, each carrying the
 *  cleaned full accumulation so far (not a delta). */
export interface TranslatePartialMsg { type: 'translate_partial'; text: string; }
export interface AsrPartialMsg { type: 'partial'; text: string; }
export interface AsrResultMsg { type: 'result'; text: string; startSample?: number; durationMs: number; recognitionTimeMs: number; }
export type NativeModelState = 'ready' | 'absent';
export interface ModelStatusResultMsg { type: 'model_status_result'; id: number; statuses: Record<string, NativeModelState>; }
export interface ModelDeleteResultMsg { type: 'model_delete_result'; id: number; model: string; freed: number; }
export interface ModelProgressMsg { type: 'model_progress'; model: string; downloaded: number; total: number; }
export type ModelDownloadStatus = 'ready' | 'cancelled';
export interface ModelDownloadDoneMsg { type: 'model_download_done'; model: string; status: ModelDownloadStatus; }
export interface TtsChunkMsg { type: 'tts_chunk'; id: number; seq: number; }
export interface TtsDoneMsg { type: 'tts_done'; id: number; totalSamples: number; generationTimeMs: number; }
export interface ListTtsVoicesResultMsg { type: 'list_tts_voices_result'; id: number; voices: string[]; }
export type ServerMsg = ReadyMsg | OkMsg | TtsGenerateResultMsg | TranslateResultMsg | TranslatePartialMsg | AsrPartialMsg | AsrResultMsg | ModelStatusResultMsg | ModelDeleteResultMsg | ModelProgressMsg | ModelDownloadDoneMsg | ErrorMsg | HardwareInfoResultMsg | ModelsCatalogResultMsg | ListVariantsResultMsg | TtsChunkMsg | TtsDoneMsg | ListTtsVoicesResultMsg;
