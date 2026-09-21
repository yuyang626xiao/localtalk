// Conversation data model, ported (and slimmed) from Sokuji
// src/services/interfaces/IClient.ts ConversationItem (AGPL-3.0).
// One row = one item. Original and translation are TWO items (role user /
// assistant), not two lines in one bubble; the display-mode toggles decide
// which rows render. `source` picks the lane: speaker = my mic track.

export type ConversationRole = 'user' | 'assistant' | 'system';
export type ConversationLane = 'speaker' | 'participant';
export type ConversationStatus = 'in_progress' | 'completed' | 'cancelled';

export interface ConversationItem {
  id: string;
  role: ConversationRole;
  /** user = original (ASR) row, assistant = translation row, system = notice. */
  type: 'message' | 'error';
  severity?: 'error' | 'warning';
  status: ConversationStatus;
  source: ConversationLane;
  createdAt: number;
  /** The text shown (transcript for user rows, translation for assistant rows). */
  text: string;
  /** Language badge pair snapshotted when the row was created. */
  srcLang?: string;
  dstLang?: string;
  /** Inference time (ms) for completed translation rows. */
  ms?: number;
}

let seq = 0;
export const nextItemId = (p: string) => `${p}_${Date.now()}_${++seq}`;

/** Display mode of one lane's rows: both / translation only / source only / off. */
export type DisplayMode = 'both' | 'translation' | 'source' | 'none';

/**
 * Cycle order mirrors Sokuji's DisplayModeButton: a mis-click lands on
 * "translation only" (the useful neighbor), and the farthest state "off"
 * takes three deliberate clicks. both → translation → source → none → both.
 */
export function nextDisplayMode(m: DisplayMode): DisplayMode {
  switch (m) {
    case 'both': return 'translation';
    case 'translation': return 'source';
    case 'source': return 'none';
    default: return 'both';
  }
}

/** shouldShowItem (Sokuji conversationFilter.ts): errors always render. */
export function shouldShowItem(item: ConversationItem, mode: DisplayMode): boolean {
  if (item.role === 'system') return true;
  if (mode === 'both') return true;
  if (mode === 'none') return false;
  if (mode === 'source') return item.role === 'user';
  return item.role === 'assistant';
}
