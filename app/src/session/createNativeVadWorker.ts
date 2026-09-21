// Ported from Sokuji src/services/clients/createNativeVadWorker.ts (AGPL-3.0).
// Standalone factory so tests can stub the worker.
export function createNativeVadWorker(): Worker {
  return new Worker(new URL('../workers/native-vad.worker.ts', import.meta.url), {
    type: 'module',
  });
}
