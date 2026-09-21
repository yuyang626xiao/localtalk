// Small renderer-side catalog helpers, ported from Sokuji's
// src/lib/local-inference/native/nativeCatalog.ts (AGPL-3.0, trimmed to what
// LocalTalk's settings panel needs).

import type { NativeModelInfo } from './nativeProtocol';

/**
 * Translation models whose prompt is assembled entirely by the model's own chat
 * template, leaving nowhere for a user-supplied system prompt to go (Sokuji
 * #526). Pinned by id because the renderer cannot see the sidecar's
 * prompt_family — that field is not on the wire.
 */
const TEMPLATE_OWNS_PROMPT: ReadonlySet<string> = new Set(['translategemma-4b']);

/** Whether a translation model honours a user-supplied system prompt. An
 *  unknown or still-unresolved id answers true (resting state = available). */
export function supportsCustomPrompt(translationModelId: string): boolean {
  return !TEMPLATE_OWNS_PROMPT.has(translationModelId);
}

const LANG_NAMES: Record<string, string> = {
  zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French',
  de: 'German', es: 'Spanish', ru: 'Russian', pt: 'Portuguese', it: 'Italian',
  th: 'Thai', vi: 'Vietnamese', ar: 'Arabic',
};

/** Mirror of the sidecar's translate_backend._default_prompt — what the
 *  "快捷" (template) mode previews as the effective system instruction. */
export function defaultPromptPreview(src: string, tgt: string): string {
  const s = LANG_NAMES[src] || 'the source language';
  const t = LANG_NAMES[tgt] || 'the target language';
  return `You are a translator. Translate the text from ${s} to ${t}. `
    + 'Output only the translation, no explanations, no refusal.';
}

/**
 * estimateNativeMemoryByDevice (Sokuji nativeCatalog): sum the selected cards'
 * download sizes, routed to VRAM when the card has an available non-cpu tier.
 * A missing/zero size is skipped so a not-yet-measured model shows no phantom 0.
 */
export function estimateNativeMemory(
  stages: { id?: string }[],
  catalog: Record<string, NativeModelInfo>,
): { vramMb: number; ramMb: number } {
  let vramMb = 0;
  let ramMb = 0;
  for (const { id } of stages) {
    if (!id) continue;
    const card = catalog[id];
    const mb = Math.round((card?.sizeBytes || 0) / 1_048_576);
    if (mb === 0) continue;
    const gpuAvailable = !!card?.tiers.some((t) => t.available && t.tier !== 'cpu');
    if (gpuAvailable) vramMb += mb; else ramMb += mb;
  }
  return { vramMb, ramMb };
}

/** Format a megabyte figure: GB (one decimal) at/over 1024 MB, MB below. */
export function formatMemMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
