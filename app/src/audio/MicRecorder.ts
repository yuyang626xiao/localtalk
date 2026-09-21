// Mic capture → mono Int16 PCM at a fixed target rate, in 40 ms chunks.
// Ported core from the LocalTalk v0 recorder; the noise-suppression graph
// (RNNoise worklet / GTCRN worker), device selection, passthrough monitoring
// and output routing follow Sokuji's ModernAudioRecorder semantics (AGPL-3.0).
//
// Graph:  srcNode → [rnnoise?] → resampler-worklet → zero-gain sink
//                       (enhanced mode re-routes the worklet's PCM through
//                        the GTCRN ORT worker before delivery)
//         srcNode → passthrough-gain(0.3) → destination   (raw voice monitor)

import workletUrl from './resampler-worklet.js?url';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export type NoiseMode = 'off' | 'standard' | 'enhanced';

export interface MicStartOpts {
  deviceId?: string;
  noiseMode?: NoiseMode;
  passthrough?: boolean;
  outputSinkId?: string;
}

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private ptGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private aBuf = new Float32Array(512);
  private flushing = false;

  private onChunk: (i16: Int16Array) => void = () => undefined;
  private targetRate = 24000;
  private noiseMode: NoiseMode = 'off';
  private noiseOpId = 0;

  // RNNoise (standard)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rnnoiseNode: any = null;
  private rnnoiseWasmBinary: ArrayBuffer | null = null;
  private rnnoiseModuleLoaded = false;

  // GTCRN (enhanced)
  private gtcrnWorker: Worker | null = null;
  private gtcrnReady = false;
  private gtcrnUnavailable = false;

  get active(): boolean { return !!this.ctx; }
  get noise(): NoiseMode { return this.noiseMode; }

  /** Input level 0..1 (RMS, sqrt-scaled for display). */
  level(): number {
    if (!this.analyser || !this.ctx) return 0;
    this.analyser.getFloatTimeDomainData(this.aBuf);
    let sum = 0;
    for (let i = 0; i < this.aBuf.length; i++) sum += this.aBuf[i] * this.aBuf[i];
    return Math.min(1, Math.sqrt(Math.sqrt(sum / this.aBuf.length) * 6));
  }

  /** onChunk receives Int16 mono PCM at `targetRate` (post-denoise when a
   *  suppression mode is active). */
  async start(onChunk: (i16: Int16Array) => void, targetRate = 24000, opts: MicStartOpts = {}): Promise<void> {
    if (this.ctx) throw new Error('MicRecorder already started');
    this.onChunk = onChunk;
    this.targetRate = targetRate;
    const ctx = new AudioContext();
    try {
      await ctx.resume();
      if (opts.outputSinkId && typeof ctx.setSinkId === 'function') {
        await ctx.setSinkId(opts.outputSinkId).catch(() => undefined);   // passthrough follows the chosen speaker
      }
      await ctx.audioWorklet.addModule(workletUrl);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,      // WebRTC APM baseline — always on (Sokuji HIGH_QUALITY profile)
          autoGainControl: true,
        },
      });
      const node = new AudioWorkletNode(ctx, 'pcm-resampler', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
        processorOptions: { targetRate },
      });
      node.port.onmessage = (e: MessageEvent) => this._fromWorklet(e);
      const srcNode = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain();
      sink.gain.value = 0;                  // silent pull: keeps the worklet running
      srcNode.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      // Input level tap (raw mic, pre-denoise) for the control-bar meter.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const aSink = ctx.createGain();
      aSink.gain.value = 0;
      srcNode.connect(analyser);
      analyser.connect(aSink);
      aSink.connect(ctx.destination);
      this.ctx = ctx; this.stream = stream; this.node = node; this.srcNode = srcNode; this.sink = sink;
      this.analyser = analyser;
      this.rnnoiseModuleLoaded = false;   // worklet modules are per-AudioContext
      this.rnnoiseNode = null;            // old node died with the old graph

      if (opts.passthrough) this.setPassthrough(true);
      // Re-apply against the FRESH graph even if the mode field survived from
      // before the stop (the nodes were rebuilt, the worker connection died).
      this.noiseMode = 'off';
      if (opts.noiseMode && opts.noiseMode !== 'off') await this.setNoiseMode(opts.noiseMode);
    } catch (e) {
      await ctx.close().catch(() => undefined);
      throw e;
    }
  }

  private _fromWorklet(e: MessageEvent): void {
    if (typeof e.data === 'string') {          // 'flushed'
      this._teardown();
      return;
    }
    const pcm = e.data as Int16Array;
    if (this.noiseMode === 'enhanced' && this.gtcrnReady && this.gtcrnWorker) {
      this.gtcrnWorker.postMessage({ type: 'process', audio: pcm }, [pcm.buffer]);
    } else {
      this.onChunk(pcm);
    }
  }

  /** Live passthrough monitor (raw voice → selected speaker, 30%). */
  setPassthrough(on: boolean, volume = 0.3): void {
    if (!this.ctx || !this.srcNode) return;
    if (on) {
      if (!this.ptGain) {
        this.ptGain = this.ctx.createGain();
        this.ptGain.gain.value = volume;
        this.srcNode.connect(this.ptGain);
        this.ptGain.connect(this.ctx.destination);
      } else {
        this.ptGain.gain.value = volume;
      }
    } else if (this.ptGain) {
      try { this.ptGain.disconnect(); } catch (_) { /* ignore */ }
      this.ptGain = null;
    }
  }

  /** Route the mic context's destination (passthrough monitor) to a speaker. */
  async setSinkId(id: string): Promise<void> {
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      await this.ctx.setSinkId(id || '').catch(() => undefined);
    }
  }

  // ==================== Noise suppression ====================

  /** Set noise mode: 'off', 'standard' (RNNoise), or 'enhanced' (GTCRN).
   *  Safe to call live; failures degrade enhanced → standard → off. */
  async setNoiseMode(mode: NoiseMode): Promise<void> {
    const prev = this.noiseMode;
    if (prev === mode) return;
    this.noiseMode = mode;
    const opId = ++this.noiseOpId;
    if (!this.ctx || !this.srcNode || !this.node) return;

    if (prev === 'standard' && mode !== 'standard') this._removeRnnoise();
    if (prev === 'enhanced' && mode !== 'enhanced') this._disconnectGtcrn();

    if (mode === 'standard') await this._insertRnnoise(opId);
    else if (mode === 'enhanced') await this._connectGtcrn(opId);
  }

  private async _insertRnnoise(opId?: number): Promise<void> {
    if (this.rnnoiseNode || !this.ctx || !this.srcNode || !this.node) return;
    try {
      const [wasmBinary] = await Promise.all([this._loadRnnoise(), this._ensureRnnoiseModule()]);
      if (opId !== undefined && opId !== this.noiseOpId) return;   // stale toggle

      const { RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
      this.rnnoiseNode = new RnnoiseWorkletNode(this.ctx, { wasmBinary, maxChannels: 1 });

      // Rewire: srcNode → rnnoise → resampler
      this.srcNode.disconnect();
      this.srcNode.connect(this.rnnoiseNode);
      this.rnnoiseNode.connect(this.node);
    } catch {
      this.rnnoiseNode = null;
      try { this.srcNode?.disconnect(); this.srcNode?.connect(this.node!); } catch (_) { /* ignore */ }
      if (opId !== undefined && opId === this.noiseOpId) this.noiseMode = 'off';
    }
  }

  private _removeRnnoise(): void {
    if (!this.rnnoiseNode || !this.srcNode || !this.node) return;
    try {
      this.srcNode.disconnect();
      this.rnnoiseNode.disconnect();
      this.rnnoiseNode.destroy();
      this.rnnoiseNode = null;
      this.srcNode.connect(this.node);
    } catch {
      try { this.srcNode.disconnect(); this.srcNode.connect(this.node); } catch (_) { /* ignore */ }
    }
  }

  private async _loadRnnoise(): Promise<ArrayBuffer> {
    if (this.rnnoiseWasmBinary) return this.rnnoiseWasmBinary;
    const { loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
    this.rnnoiseWasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
    return this.rnnoiseWasmBinary;
  }

  private async _ensureRnnoiseModule(): Promise<void> {
    if (this.rnnoiseModuleLoaded) return;
    if (!this.ctx) throw new Error('AudioContext required');
    await this.ctx.audioWorklet.addModule(rnnoiseWorkletPath);
    this.rnnoiseModuleLoaded = true;
  }

  private async _connectGtcrn(opId?: number): Promise<void> {
    if (!this.node) return;
    if (this.gtcrnUnavailable) {                       // known-broken env: degrade once, no re-attempt
      if (opId !== undefined && opId !== this.noiseOpId) return;
      this.noiseMode = 'standard';
      await this._insertRnnoise();
      return;
    }
    try {
      if (!this.gtcrnWorker) {
        this.gtcrnWorker = new Worker(new URL('../workers/gtcrn/gtcrn.worker.ts', import.meta.url), { type: 'module' });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('GTCRN worker init timeout')), 10000);
          const w = this.gtcrnWorker!;
          w.onmessage = (event: MessageEvent) => {
            if (event.data.type === 'ready') { clearTimeout(timeout); w.onerror = null; this.gtcrnReady = true; resolve(); }
            else if (event.data.type === 'error') { clearTimeout(timeout); reject(new Error(event.data.message)); }
            else if (event.data.type === 'audio') { this.onChunk(event.data.audio as Int16Array); }
          };
          w.onerror = () => { clearTimeout(timeout); reject(new Error('GTCRN worker failed to load')); };
          w.postMessage({
            type: 'init',
            ortWasmBaseUrl: new URL('./wasm/ort/', window.location.href).href,
            modelUrl: new URL('./wasm/gtcrn/gtcrn_simple.onnx', window.location.href).href,
            inputSampleRate: this.targetRate,
          });
        });
      }
      if (opId !== undefined && opId !== this.noiseOpId) return;
      this.gtcrnWorker.onmessage = (event: MessageEvent) => {
        if (event.data.type === 'audio') this.onChunk(event.data.audio as Int16Array);
        else if (event.data.type === 'error') { console.warn('[mic] GTCRN runtime error → standard:', event.data.message); void this.setNoiseMode('standard'); }
      };
    } catch (error) {
      this.gtcrnUnavailable = true;
      console.warn('[mic] GTCRN (enhanced) unavailable — falling back to RNNoise:', error);
      this.gtcrnReady = false;
      this._disposeGtcrn();
      if (opId !== undefined && opId !== this.noiseOpId) return;
      try {
        this.noiseMode = 'standard';
        await this._insertRnnoise();
      } catch {
        this.noiseMode = 'off';
      }
    }
  }

  private _disconnectGtcrn(): void {
    this.gtcrnWorker?.postMessage({ type: 'reset' });
  }

  private _disposeGtcrn(): void {
    this._disconnectGtcrn();
    if (this.gtcrnWorker) {
      this.gtcrnWorker.postMessage({ type: 'dispose' });
      this.gtcrnWorker.terminate();
      this.gtcrnWorker = null;
      this.gtcrnReady = false;
    }
  }

  // ==================== Lifecycle ====================

  /** Flush the worklet's partial tail, then tear everything down. The returned
   *  promise settles after the last audio chunk has been delivered, so callers
   *  can safely emit an ASR `end` mark right after awaiting it. */
  stop(): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    if (this.flushing) return new Promise<void>((resolve) => {
      const check = setInterval(() => { if (!this.ctx) { clearInterval(check); resolve(); } }, 20);
    });
    this.flushing = true;
    this.node?.port.postMessage('flush');
    return new Promise<void>((resolve) => {
      // 'flushed' arrives via onmessage -> _teardown(); bound the wait anyway.
      const t0 = Date.now();
      const check = setInterval(() => {
        if (!this.ctx || Date.now() - t0 > 500) {
          clearInterval(check);
          if (!this.ctx) this.flushing = false;
          resolve();
        }
      }, 10);
    });
  }

  private _teardown(): void {
    try { this.srcNode?.disconnect(); } catch (_) { /* ignore */ }
    try { this.node?.disconnect(); } catch (_) { /* ignore */ }
    try { this.sink?.disconnect(); } catch (_) { /* ignore */ }
    try { this.ptGain?.disconnect(); } catch (_) { /* ignore */ }
    this.ptGain = null;
    if (this.rnnoiseNode) { try { this.rnnoiseNode.destroy(); } catch (_) { /* ignore */ } this.rnnoiseNode = null; }
    // NOTE: the GTCRN worker deliberately survives mic stop — re-initing it
    // on every PTT press would reload the model each time. Call dispose()
    // (session teardown) to terminate it for real.
    if (this.gtcrnWorker) this.gtcrnWorker.postMessage({ type: 'reset' });
    this.stream?.getTracks().forEach((tr) => tr.stop());
    const ctx = this.ctx;
    this.ctx = null; this.stream = null; this.node = null; this.srcNode = null; this.sink = null;
    this.analyser = null;
    ctx?.close().catch(() => undefined);
  }

  /** Full teardown including the GTCRN worker (session dispose). */
  dispose(): void {
    this._teardown();
    this._disposeGtcrn();
  }
}
