// Ported verbatim from Sokuji src/lib/local-inference/workers/_shared/onnxruntime-all.ts
// (AGPL-3.0, © Kizuna AI Lab).
/**
 * Barrel shim for onnxruntime-web — pins the import surface via a top-level
 * side-effect so per-worker tree-shaking produces identical chunks.
 *
 * Vite bundles each worker as its own Rollup build, so manualChunks runs
 * per-worker. Without this shim each worker tree-shakes a different subset
 * of ORT, producing distinct chunks per consumer. The pin assignment below
 * is a real side effect that references every binding via the namespace
 * import, forcing them to be retained in every consumer's bundle.
 */

import * as ORT from 'onnxruntime-web';

(self as { __ortPin?: unknown }).__ortPin = [
  ORT.InferenceSession,
  ORT.Tensor,
  ORT.env,
];

export { InferenceSession, Tensor, env } from 'onnxruntime-web';
