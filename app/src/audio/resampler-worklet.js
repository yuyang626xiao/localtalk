// Linear-interpolating downmixing resampler: context-rate mono Float32 →
// target-rate Int16 PCM chunks (the format the sidecar's ASR feed expects:
// raw Int16 mono at the sampleRate declared in asr_init).
//
// Loads as an AudioWorklet module. Chunk size: 960 target samples = 40 ms @24k.
class PcmResamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 24000;
    // AudioWorkletGlobalScope.sampleRate — the bare global. `globalContext` was
    // REMOVED in Chromium 130; Electron 34 (Chromium 132) throws ReferenceError
    // there, which kills the processor constructor and silently starves the
    // whole mic pipeline (zero chunks → ASR never sees audio).
    this.srcRate = sampleRate;
    this.ratio = this.srcRate / this.targetRate;
    this.in = new Float32Array(0);   // pending input (always >= read position)
    this.pos = 0;                    // fractional read index into `in`
    this.acc = new Int16Array(960);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this._flush();
    };
  }

  _emit() {
    if (this.n > 0) {
      const out = this.acc.slice(0, this.n);
      this.port.postMessage(out, [out.buffer]);
      this.acc = new Int16Array(960);
      this.n = 0;
    }
  }

  _flush() {
    // Drain everything still readable (one trailing sample is kept un-read by
    // the interpolator's i0+1 guard; pad by repeating the last input value).
    const total = Math.floor(this.pos) < this.in.length ? (this.in.length - Math.floor(this.pos)) * this.ratio : 0;
    void total;
    this._pump(true);
    this._emit();
    this.port.postMessage('flushed');
  }

  _pump(drain) {
    const len = this.in.length;
    // need in[i0] and in[i0+1]; at drain-time the last readable point uses a clamped tail
    while (this.pos < len - 1 || (drain && this.pos < len)) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const a = this.in[i0];
      const b = this.in[Math.min(i0 + 1, len - 1)];
      let v = a * (1 - frac) + b * frac;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      this.acc[this.n++] = (v < 0 ? v * 32768 : v * 32767) | 0;
      if (this.n === this.acc.length) this._emit();
      this.pos += this.ratio;
    }
    if (!drain) {
      const consumed = Math.floor(this.pos);
      if (consumed > 0) {
        this.in = this.in.subarray(consumed);
        this.pos -= consumed;
      }
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // append (subarray reads are zero-copy until we grow)
    const merged = new Float32Array(this.in.length + ch.length);
    merged.set(this.in);
    merged.set(ch, this.in.length);
    this.in = merged;
    this._pump(false);
    return true;
  }
}

registerProcessor('pcm-resampler', PcmResamplerProcessor);
