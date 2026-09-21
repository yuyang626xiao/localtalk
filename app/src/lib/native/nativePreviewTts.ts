// Ported from Sokuji src/lib/local-inference/native/nativePreviewTts.ts
// (AGPL-3.0, © Kizuna AI Lab). Personal/internal use.
//
// Synthesize one sentence through the sidecar's TTS on a connection THIS
// module owns — never the session's client: a live session's engine must not
// be evicted by a preview (engines are process singletons). When no session
// holds TTS, this handle loads the model itself, keeps it warm between
// previews, and releases it on close().
//
// The _not_owner_error recovery matters for our layout too: after a session
// closes, the sidecar may still record the dead session's connection as the
// engine owner; one re-init claims it cleanly. A second failure propagates.

import { NativeTtsClient } from './NativeTtsClient';

export type PreviewVoice =
  | { kind: 'name'; name: string }
  | { kind: 'clip'; audio: Float32Array; sampleRate: number; refText?: string };

export interface PreviewTtsHandle {
  /** One sentence, reusing the warm engine when modelId AND language match
   *  what is loaded (language is stored on the engine at init — a stale one
   *  would mispronounce the next preview under the OLD phonology). */
  synthesize(args: {
    modelId: string; language: string; text: string; speed: number; voice: PreviewVoice;
  }): Promise<{ audio: Float32Array; sampleRate: number }>;
  /** Drop the connection; the sidecar frees the resident model. */
  close(): void;
}

function isNotOwnerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('_not_owner_error');
}

async function applyVoice(client: NativeTtsClient, voice: PreviewVoice): Promise<void> {
  if (voice.kind === 'name') await client.setVoice(voice.name);
  else await client.setReferenceVoice(voice.audio, voice.sampleRate, voice.refText);
}

/** onChunk is passed ALWAYS (upstream lesson, 2026-09-18): the SIDECAR picks
 *  the protocol from the loaded engine's streaming flag; a streaming family
 *  answers with chunks and never sends tts_generate_result. The client's own
 *  `streaming && onChunk` guard keeps one-shot families on the whole-buffer
 *  path, so passing the callback unconditionally is safe for both. */
async function synthesizeOnce(
  client: NativeTtsClient, text: string, speed: number,
): Promise<{ audio: Float32Array; sampleRate: number }> {
  const chunks: Float32Array[] = [];
  const result = await client.generate(text, speed, (pcm) => { chunks.push(pcm); });
  if (chunks.length === 0) return { audio: result.samples, sampleRate: result.sampleRate };
  let total = 0;
  for (const c of chunks) total += c.length;
  const audio = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { audio.set(c, at); at += c.length; }
  return { audio, sampleRate: result.sampleRate };
}

export function createPreviewTts(): PreviewTtsHandle {
  let client: NativeTtsClient | null = null;
  let loadedModelId: string | null = null;
  let loadedLanguage: string | null = null;

  const initFor = async (modelId: string, language: string): Promise<void> => {
    const c = client!;
    // device/variant deliberately omitted: a preview auditions the VOICE, and
    // the sidecar picks its own placement.
    await c.init(modelId, undefined, language);
    loadedModelId = modelId;
    loadedLanguage = language;
  };

  return {
    async synthesize({ modelId, language, text, speed, voice }) {
      if (!client) client = new NativeTtsClient();
      if (loadedModelId !== modelId || loadedLanguage !== language) await initFor(modelId, language);
      await applyVoice(client, voice);
      try {
        return await synthesizeOnce(client, text, speed);
      } catch (err) {
        if (!isNotOwnerError(err)) throw err;
        await initFor(modelId, language);
        await applyVoice(client, voice);
        return await synthesizeOnce(client, text, speed);
      }
    },
    close() {
      client?.dispose();
      client = null;
      loadedModelId = null;
      loadedLanguage = null;
    },
  };
}
