// Ported (trimmed) from Sokuji src/lib/local-inference/nativeVoiceStorage.ts +
// nativeVoiceStores.ts (AGPL-3.0, © Kizuna AI Lab). Personal/internal use.
//
// User voice library for zero-shot TTS cloning: reference clips stored as raw
// Float32 PCM in IndexedDB. Deliberately its OWN database — clips are user
// assets, never wiped by "delete all models", and never touched by the
// model-cache DB's versioning. (Upstream used the `idb` package; this port
// hand-rolls the same three calls to avoid a new dependency.)

export interface StoredVoiceClip {
  id: number;
  name: string;
  audio: ArrayBuffer;
  sampleRate: number;
  createdAt: number;
  /** Reference transcript for the clip — required by ASR-conditioned cloning
   *  models (qwen3_tts / omnivoice), optional elsewhere. */
  transcript?: string;
}

/** What a session needs to clone: decoded PCM + its rate + optional transcript. */
export interface VoiceApplyPayload {
  audio: Float32Array;
  sampleRate: number;
  transcript?: string;
}

const DB_NAME = 'localtalk-native-voices';
const DB_VERSION = 1;
const STORE = 'voices';

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) {
          open.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('IndexedDB 被其他窗口占用'));
    }).catch((err) => { dbPromise = null; throw err; });   // don't poison the cache
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return getDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function listVoices(): Promise<StoredVoiceClip[]> {
  return run<StoredVoiceClip[]>('readonly', (s) => s.getAll() as IDBRequest<StoredVoiceClip[]>);
}

export function getVoice(id: number): Promise<StoredVoiceClip | undefined> {
  return run<StoredVoiceClip | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredVoiceClip | undefined>);
}

/** Decode an IndexedDB record into what a session applies. */
export function voicePayload(v: StoredVoiceClip): VoiceApplyPayload {
  return { audio: new Float32Array(v.audio), sampleRate: v.sampleRate, transcript: v.transcript };
}

export async function addVoice(name: string, audio: Float32Array, sampleRate: number, transcript?: string): Promise<StoredVoiceClip> {
  const existing = await listVoices();
  const finalName = uniquifyName(name.trim() || '克隆音色', existing.map((v) => v.name));
  const buf = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  const record: Omit<StoredVoiceClip, 'id'> = {
    name: finalName, audio: buf, sampleRate, createdAt: Date.now(), ...(transcript ? { transcript } : {}),
  };
  const id = await run<number>('readwrite', (s) => s.add(record) as unknown as IDBRequest<number>);
  return { id, ...record };
}

export async function renameVoice(id: number, name: string): Promise<void> {
  const cur = await getVoice(id);
  if (!cur) throw new Error(`voice ${id} not found`);
  await run<IDBValidKey>('readwrite', (s) => s.put({ ...cur, name }));
}

export function deleteVoice(id: number): Promise<undefined> {
  return run<undefined>('readwrite', (s) => s.delete(id));
}

export function uniquifyName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

/* ---------------- clip validation (ported from nativeVoiceStores.ts) ------ */

/** Reference-clip bounds: too short carries no timbre, too long wastes
 *  storage and slows cloning. Zero-shot guidance: ~3-20s. */
export const MIN_CLIP_SECONDS = 3;
export const MAX_CLIP_SECONDS = 20;

/** Per-model clip limits (seconds) — some families degrade past a shorter cap. */
const MODEL_CLIP_LIMITS: Record<string, { min?: number; max?: number }> = {
  // OmniVoice's non-AR decode degrades past ~8s of reference; the sidecar caps it.
  'omnivoice-0.6b': { max: 8 },
};

export function clipLimits(modelId?: string): { min: number; max: number } {
  const l = (modelId && MODEL_CLIP_LIMITS[modelId]) || {};
  return { min: l.min ?? MIN_CLIP_SECONDS, max: l.max ?? MAX_CLIP_SECONDS };
}

/** Peak below this is treated as silence (a muted mic / empty file). */
const SILENCE_PEAK_THRESHOLD = 0.01;

export type ClipValidationError = 'too_short' | 'too_long' | 'silent';

export const CLIP_ERROR_TEXT: Record<ClipValidationError, string> = {
  too_short: '音频太短（至少 3 秒），参考不足无法提取音色',
  too_long: '音频太长，请截取 3-20 秒的清晰人声',
  silent: '没有检测到声音（音量过低或设备选择错误）',
};

/** Pure validation for a captured/decoded clip. Peak (not mean-abs): a quiet
 *  but genuine recording must pass — loudness is fixed by normalizePeak. */
export function validateVoiceClip(
  clip: Float32Array, sampleRate: number, maxSeconds = MAX_CLIP_SECONDS, minSeconds = MIN_CLIP_SECONDS,
): ClipValidationError | null {
  const seconds = sampleRate > 0 ? clip.length / sampleRate : 0;
  if (seconds < minSeconds) return 'too_short';
  if (seconds > maxSeconds) return 'too_long';
  let peak = 0;
  for (let i = 0; i < clip.length; i++) { const a = Math.abs(clip[i]); if (a > peak) peak = a; }
  if (peak < SILENCE_PEAK_THRESHOLD) return 'silent';
  return null;
}

/** Peak-normalize to `target` so a quiet recording stores/previews/clones at a
 *  usable level. No-op on (near-)silence. */
export function normalizePeak(clip: Float32Array, target = 0.95): Float32Array {
  let peak = 0;
  for (let i = 0; i < clip.length; i++) { const a = Math.abs(clip[i]); if (a > peak) peak = a; }
  if (peak < 1e-5) return clip;
  const gain = target / peak;
  const out = new Float32Array(clip.length);
  for (let i = 0; i < clip.length; i++) out[i] = clip[i] * gain;
  return out;
}

/** Downmix an AudioBuffer to mono (channel average). */
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels <= 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < buffer.length; i++) out[i] /= channels;
  return out;
}
