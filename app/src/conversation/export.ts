// Conversation export, ported (and slimmed) from Sokuji
// src/utils/conversationExport.ts (AGPL-3.0). txt and json formats,
// filename pattern sokuji-conversation-YYYYMMDD-HHMMSS -> localtalk-*.
// Only completed message rows export; in-flight partials and system notices
// are excluded, exactly like the original normalizeMessages().

import type { ConversationItem } from './model';

export interface ExportScope {
  speakerOriginal: boolean;
  speakerTranslation: boolean;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(d: Date) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function clockTime(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function exportable(items: ConversationItem[]): ConversationItem[] {
  return items.filter((i) => i.type === 'message' && i.role !== 'system' && i.status === 'completed' && i.text.trim());
}

export function buildTxt(items: ConversationItem[], scope: ExportScope, meta: { sourceLang: string; targetLang: string; models: string[] }): string {
  const now = new Date();
  const lines: string[] = [
    'LocalTalk 对话记录',
    `生成时间: ${now.toLocaleString('zh-CN')}`,
    `语言方向: ${meta.sourceLang} → ${meta.targetLang}`,
    `模型: ${meta.models.join(' / ')}`,
    '',
  ];
  for (const it of exportable(items)) {
    const t = clockTime(new Date(it.createdAt));
    if (it.role === 'user') {
      if (!scope.speakerOriginal) continue;
      lines.push(`[${t}] 我:      ${it.text}`);
    } else {
      if (!scope.speakerTranslation) continue;
      lines.push(`[${t}] 我 (译):    ${it.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function buildJson(items: ConversationItem[], scope: ExportScope, meta: { sourceLang: string; targetLang: string; models: string[] }): string {
  const messages = exportable(items)
    .filter((it) => (it.role === 'user' ? scope.speakerOriginal : scope.speakerTranslation))
    .map((it) => ({
      id: it.id,
      timestamp: new Date(it.createdAt).toISOString(),
      source: 'you' as const,
      kind: it.role === 'user' ? ('original' as const) : ('translation' as const),
      text: it.text,
      ...(it.srcLang ? { sourceLanguage: it.srcLang } : {}),
      ...(it.dstLang ? { targetLanguage: it.dstLang } : {}),
    }));
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: 'localtalk',
    session: { models: meta.models, sourceLanguage: meta.sourceLang, targetLanguage: meta.targetLang },
    messageCount: messages.length,
    messages,
  }, null, 2);
}

/** Blob + <a download> (Sokuji downloadFile). */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function exportFilename(ext: string): string {
  return `localtalk-conversation-${stamp(new Date())}.${ext}`;
}
