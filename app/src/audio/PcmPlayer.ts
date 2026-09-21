// Gap-free playback queue for the sidecar's TTS PCM (Float32 mono @ 24 kHz).
// One AudioContext at the stream rate; chunks are scheduled back-to-back on a
// cursor so streaming synthesis plays as it arrives.

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private aBuf = new Float32Array(512);
  private cursor = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private _volume = 0.9;
  private _sinkId = '';

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this._volume;
      this.gain.connect(this.ctx.destination);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      const aSink = this.ctx.createGain();
      aSink.gain.value = 0;
      this.gain.connect(analyser);
      analyser.connect(aSink);
      aSink.connect(this.ctx.destination);
      this.analyser = analyser;
      if (this._sinkId && typeof this.ctx.setSinkId === 'function') {
        void this.ctx.setSinkId(this._sinkId).catch(() => undefined);
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Playback level 0..1 for the control-bar meter. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.aBuf);
    let sum = 0;
    for (let i = 0; i < this.aBuf.length; i++) sum += this.aBuf[i] * this.aBuf[i];
    return Math.min(1, Math.sqrt(Math.sqrt(sum / this.aBuf.length) * 6));
  }

  /** Route TTS playback to a specific output device ('' = system default). */
  async setSinkId(id: string): Promise<void> {
    this._sinkId = id;
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      await this.ctx.setSinkId(id).catch(() => undefined);
    }
  }

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this._volume;
  }
  get volume(): number { return this._volume; }

  /** Queue one Float32 PCM chunk at 24 kHz. */
  play(pcm: Float32Array): void {
    if (!pcm.length) return;
    const ctx = this.ensure();
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    buf.getChannelData(0).set(pcm);   // avoids copyToChannel's stricter ArrayBuffer generic
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);
    const start = Math.max(this.cursor, ctx.currentTime + 0.01);
    src.start(start);
    this.cursor = start + buf.duration;
    src.onended = () => { this.sources.delete(src); };
    this.sources.add(src);
  }

  get playing(): boolean { return this.sources.size > 0; }

  /** Stop everything immediately (next play() starts at once). */
  interrupt(): void {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch (_) { /* ignore */ } }
    this.sources.clear();
    if (this.ctx) this.cursor = 0;
  }

  close(): void {
    this.interrupt();
    const ctx = this.ctx;
    this.ctx = null; this.gain = null; this.analyser = null;
    ctx?.close().catch(() => undefined);
  }
}
