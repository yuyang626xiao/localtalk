// GTCRN enhanced noise-suppression worker, ported from Sokuji
// src/lib/modern-audio/gtcrn/gtcrn-worker.ts (AGPL-3.0, © Kizuna AI Lab).
// Adapted for LocalTalk: ORT comes from our shared barrel (same pin as the
// VAD worker) and the input rate is a parameter — our mic worklet emits
// Int16 at 24 kHz, not Sokuji's 48 kHz.
//
// Pipeline per chunk: int16@inRate → float32 → resample→16k → STFT frames
// (512/hop 256, sqrt-Hann) → GTCRN session.run (RNN caches persist across
// frames) → ISTFT overlap-add → resample→inRate → int16 back.

import { InferenceSession, Tensor, env as ortEnv } from '../_shared/onnxruntime-all';
import {
  GTCRN_SAMPLE_RATE,
  GTCRN_N_FFT,
  GTCRN_HOP_LENGTH,
  GTCRN_FREQ_BINS,
  createSqrtHannWindow,
  applyWindow,
  rfft,
  irfft,
  int16ToFloat32,
  float32ToInt16,
  resample,
} from './audio-utils';

let inputSampleRate = 48000;   // set from the main thread during init

let session: InferenceSession | null = null;
let win: Float32Array;

// RNN state tensors (persist across frames)
let convCache: Tensor;
let traCache: Tensor;
let interCache: Tensor;

// Ring buffer for accumulating input samples at 16kHz
let inputBuffer: Float32Array = new Float32Array(0);

// Previous frame for overlap-add
let prevFrame: Float32Array = new Float32Array(GTCRN_N_FFT);

function initStates(): void {
  convCache = new Tensor('float32', new Float32Array(2 * 1 * 16 * 16 * 33), [2, 1, 16, 16, 33]);
  traCache = new Tensor('float32', new Float32Array(2 * 3 * 1 * 1 * 16), [2, 3, 1, 1, 16]);
  interCache = new Tensor('float32', new Float32Array(2 * 1 * 33 * 16), [2, 1, 33, 16]);
  prevFrame = new Float32Array(GTCRN_N_FFT);
}

async function init(ortWasmBaseUrl: string, modelUrl: string, inRate: number): Promise<void> {
  try {
    inputSampleRate = inRate || 48000;
    // Set ORT WASM paths from main thread's resolved URL (relative paths
    // don't resolve inside workers).
    ortEnv.wasm.wasmPaths = ortWasmBaseUrl;
    ortEnv.wasm.proxy = false; // Already in a worker
    // Single-threaded, matching the VAD worker: the only bundled artifacts
    // are *-threaded* builds; leaving numThreads at its core-count default
    // makes ORT spawn pthread workers via SharedArrayBuffer, which can hang
    // InferenceSession.create() (no throw) in a worker context.
    ortEnv.wasm.numThreads = 1;

    session = await InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    win = createSqrtHannWindow(GTCRN_N_FFT);
    initStates();

    self.postMessage({ type: 'ready' });
  } catch (error) {
    self.postMessage({ type: 'error', message: `Failed to initialize GTCRN: ${error instanceof Error ? error.message : String(error)}` });
  }
}

async function processFrame(frameRe: Float32Array, frameIm: Float32Array): Promise<[Float32Array, Float32Array]> {
  if (!session) throw new Error('Session not initialized');

  // Build input tensor: (1, 257, 1, 2) — [real, imag] stacked on last dim
  const mixData = new Float32Array(GTCRN_FREQ_BINS * 2);
  for (let i = 0; i < GTCRN_FREQ_BINS; i++) {
    mixData[i * 2] = frameRe[i];
    mixData[i * 2 + 1] = frameIm[i];
  }
  const mixTensor = new Tensor('float32', mixData, [1, GTCRN_FREQ_BINS, 1, 2]);

  const feeds: Record<string, Tensor> = {
    mix: mixTensor,
    conv_cache: convCache,
    tra_cache: traCache,
    inter_cache: interCache,
  };

  const results = await session.run(feeds);

  // Update states
  convCache = results['conv_cache_out'];
  traCache = results['tra_cache_out'];
  interCache = results['inter_cache_out'];

  // Extract enhanced spectrum
  const enhData = results['enh'].data as Float32Array;
  const enhRe = new Float32Array(GTCRN_FREQ_BINS);
  const enhIm = new Float32Array(GTCRN_FREQ_BINS);
  for (let i = 0; i < GTCRN_FREQ_BINS; i++) {
    enhRe[i] = enhData[i * 2];
    enhIm[i] = enhData[i * 2 + 1];
  }

  return [enhRe, enhIm];
}

async function processAudio(audio: Int16Array): Promise<void> {
  if (!session) return;

  // Convert Int16 @ inputSampleRate → Float32 16kHz
  const float32 = int16ToFloat32(audio);
  const resampled = resample(float32, inputSampleRate, GTCRN_SAMPLE_RATE);

  // Append to input ring buffer
  const newBuffer = new Float32Array(inputBuffer.length + resampled.length);
  newBuffer.set(inputBuffer);
  newBuffer.set(resampled, inputBuffer.length);
  inputBuffer = newBuffer;

  // Collect output samples for this chunk
  const outputSamples: Float32Array[] = [];

  // Process frames while we have enough samples
  while (inputBuffer.length >= GTCRN_N_FFT) {
    const frame = new Float32Array(GTCRN_N_FFT);
    frame.set(inputBuffer.subarray(0, GTCRN_N_FFT));
    inputBuffer = inputBuffer.subarray(GTCRN_HOP_LENGTH);

    applyWindow(frame, win);
    const [re, im] = rfft(frame);
    const [enhRe, enhIm] = await processFrame(re, im);
    const timeDomain = irfft(enhRe, enhIm, GTCRN_N_FFT);
    applyWindow(timeDomain, win);

    // Overlap-add with previous frame
    const hopOutput = new Float32Array(GTCRN_HOP_LENGTH);
    for (let i = 0; i < GTCRN_HOP_LENGTH; i++) {
      hopOutput[i] = prevFrame[i + GTCRN_HOP_LENGTH] + timeDomain[i];
    }
    prevFrame.set(timeDomain);
    outputSamples.push(hopOutput);
  }

  if (outputSamples.length === 0) return;

  const totalLength = outputSamples.reduce((acc, s) => acc + s.length, 0);
  const concatenated = new Float32Array(totalLength);
  let offset = 0;
  for (const samples of outputSamples) {
    concatenated.set(samples, offset);
    offset += samples.length;
  }

  // Resample back 16kHz → input rate, convert to Int16 and send back
  const upsampled = resample(concatenated, GTCRN_SAMPLE_RATE, inputSampleRate);
  const outputInt16 = float32ToInt16(upsampled);
  self.postMessage({ type: 'audio', audio: outputInt16 }, { transfer: [outputInt16.buffer] });
}

// Serialize all message handling to prevent concurrent access to shared state
let commandQueue: Promise<void> = Promise.resolve();

function enqueueCommand(task: () => Promise<void> | void): void {
  commandQueue = commandQueue
    .then(() => task())
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      self.postMessage({ type: 'error', message: `GTCRN worker error: ${message}` });
    });
}

self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;
  switch (type) {
    case 'init':
      enqueueCommand(() => init(event.data.ortWasmBaseUrl, event.data.modelUrl, event.data.inputSampleRate));
      break;
    case 'process':
      enqueueCommand(() => processAudio(event.data.audio));
      break;
    case 'reset':
      enqueueCommand(() => {
        initStates();
        inputBuffer = new Float32Array(0);
        prevFrame = new Float32Array(GTCRN_N_FFT);
      });
      break;
    case 'dispose':
      enqueueCommand(() => {
        if (session) {
          session.release();
          session = null;
        }
      });
      break;
  }
};
