// Ported from Sokuji src/lib/local-inference/types.ts (VadWebConfig only) — AGPL-3.0.
// All durations in seconds.

/** VAD config for vad-web FrameProcessor (Silero VAD v5 + @ricky0123/vad-web). */
export interface VadWebConfig {
  /** Positive speech threshold (default 0.3) */
  threshold?: number;
  /** Negative threshold to confirm silence — hysteresis gap prevents oscillation (default derived) */
  negativeThreshold?: number;
  /** Min silence duration in seconds before ending speech segment (default 1.4) */
  minSilenceDuration?: number;
  /** Min speech duration in seconds to emit a segment (default 0.4) */
  minSpeechDuration?: number;
  /** Pre-speech pad in seconds — audio context prepended before speech start (default 0.8) */
  preSpeechPadDuration?: number;
  /** Max speech segment duration in seconds before forced split (default 20) */
  maxSpeechDuration?: number;
}
