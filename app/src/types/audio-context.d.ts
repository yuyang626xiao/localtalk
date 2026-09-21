// Chromium-only AudioContext output routing (Electron ships it; the TS DOM
// lib doesn't declare it). Call sites guard with `typeof ctx.setSinkId`.
interface AudioContext {
  setSinkId?(sinkId: string): Promise<void>;
  readonly sinkId?: string;
}
