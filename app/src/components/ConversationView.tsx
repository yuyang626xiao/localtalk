// Conversation stream view, modeled on Sokuji's MainPanel conversation area
// (AGPL-3.0 provenance; layout slimmed for LocalTalk's single-mic lanes).
// Single-column timeline: each ConversationItem is one row. Original (user)
// rows are gray italic; translations (assistant) rows are bright with the
// target-language badge. The lane toggle cycles both → translation → source →
// none, exactly like Sokuji's DisplayModeButton.

import { useEffect, useRef, useState } from 'react';
import type { ConversationItem, DisplayMode } from '../conversation/model';
import { nextDisplayMode } from '../conversation/model';
import type { ExportScope } from '../conversation/export';

const MODE_LABEL: Record<DisplayMode, string> = { both: '两者', translation: '译文', source: '原文', none: '关闭' };

export interface ConversationViewProps {
  items: ConversationItem[];
  displayMode: DisplayMode;
  onDisplayMode: (m: DisplayMode) => void;
  fontSize: number;
  onFontSize: (n: number) => void;
  compact: boolean;
  onCompact: (b: boolean) => void;
  onExport: (scope: ExportScope, format: 'txt' | 'json' | 'clipboard') => void;
  onClear: () => void;
  srcLang: string;
  dstLang: string;
}

function shouldShow(item: ConversationItem, mode: DisplayMode): boolean {
  if (item.role === 'system') return true;
  if (mode === 'none') return false;
  if (mode === 'both') return true;
  if (mode === 'source') return item.role === 'user';
  return item.role === 'assistant';
}

export default function ConversationView(p: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);           // stick-to-bottom unless user scrolls up
  const [showJump, setShowJump] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [scope, setScope] = useState<ExportScope>({ speakerOriginal: true, speakerTranslation: true });

  const visible = p.items.filter((i) => shouldShow(i, p.displayMode));

  // Auto-follow the bottom while pinned; a manual scroll-up detaches (Sokuji
  // always force-scrolled — this is the documented improvement).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, p.items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedRef.current = atBottom;
    setShowJump(!atBottom && el.scrollHeight > el.clientHeight + 80);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; pinnedRef.current = true; setShowJump(false); }
  };

  let lastLane: string | null = null;
  return (
    <div className="conv-wrap">
      <div className="conv-toolbar">
        <button className="tool-btn" title="点击切换：两者 → 译文 → 原文 → 关闭"
          onClick={() => p.onDisplayMode(nextDisplayMode(p.displayMode))}>
          <LaneGlyph mode={p.displayMode} /> {MODE_LABEL[p.displayMode]}
        </button>
        <span className="tool-sep" />
        <button className="tool-btn" disabled={p.fontSize <= 12} title="减小字号"
          onClick={() => p.onFontSize(Math.max(12, p.fontSize - 2))}>A↓</button>
        <button className="tool-btn" disabled={p.fontSize >= 64} title="增大字号"
          onClick={() => p.onFontSize(Math.min(64, p.fontSize + 2))}>A↑</button>
        <button className="tool-btn" title={p.compact ? '展开消息头' : '折叠消息头'}
          onClick={() => p.onCompact(!p.compact)}>{p.compact ? '⇕' : '⇊'}</button>
        <span className="tool-spacer" />
        <div className="export-holder">
          <button className="tool-btn" onClick={() => setExportOpen((v) => !v)}>导出 ▾</button>
          {exportOpen && (
            <div className="export-menu">
              <label><input type="checkbox" checked={scope.speakerOriginal}
                onChange={(e) => setScope((s) => ({ ...s, speakerOriginal: e.target.checked }))} /> 原文</label>
              <label><input type="checkbox" checked={scope.speakerTranslation}
                onChange={(e) => setScope((s) => ({ ...s, speakerTranslation: e.target.checked }))} /> 译文</label>
              <hr />
              <button onClick={() => { p.onExport(scope, 'clipboard'); setExportOpen(false); }}>复制到剪贴板</button>
              <button onClick={() => { p.onExport(scope, 'txt'); setExportOpen(false); }}>下载为 .txt</button>
              <button onClick={() => { p.onExport(scope, 'json'); setExportOpen(false); }}>下载为 .json</button>
            </div>
          )}
        </div>
        <button className="tool-btn" disabled={p.items.length === 0} title="清空对话（无确认）"
          onClick={p.onClear}>🗑</button>
      </div>

      <div className="conv-scroll" ref={scrollRef} onScroll={onScroll}
        style={{ ['--conv-font' as string]: `${p.fontSize}px` }}>
        {visible.length === 0 && (
          <div className="conv-empty">
            <div className="conv-empty-icon">💬</div>
            <div>点底部「开始会话」，翻译会出现在这里</div>
          </div>
        )}
        <div className="conv-list">
          {visible.map((it) => {
            const head = !p.compact && it.source !== lastLane;
            lastLane = it.source;
            return <Row key={it.id} it={it} head={head} srcLang={p.srcLang} dstLang={p.dstLang} compact={p.compact} />;
          })}
        </div>
        {showJump && <button className="jump-bottom" onClick={jumpToBottom}>↓ 回到底部</button>}
      </div>
    </div>
  );
}

function Row({ it, head, compact }: { it: ConversationItem; head: boolean; srcLang: string; dstLang: string; compact: boolean }) {
  const time = new Date(it.createdAt);
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  if (it.role === 'system') {
    return <div className={`sys-row ${it.severity || 'warning'}`}>{it.text}</div>;
  }
  const isSrc = it.role === 'user';
  const isP = it.source === 'participant';
  const who = isP ? '对方' : '我';
  return (
    <div className={`conv-row ${isSrc ? 'src' : 'tr'}${isP ? ' p' : ''}${it.status === 'in_progress' ? ' live' : ''}`}>
      {head && !compact && (
        <div className="row-head">
          <span className={`avatar${isP ? ' p' : ''}`}>{who}</span>
          <span className="row-name">{who}</span>
          <span className="row-time">{hhmm}</span>
        </div>
      )}
      {compact && <span className="role-dot" />}
      <div className="row-body">
        <span className={`lang-badge ${isSrc ? 'src' : 'tr'}`}>{isSrc ? it.srcLang : it.dstLang}</span>
        <span className="row-text">{it.text || (isSrc ? '…' : '…')}</span>
        {it.role === 'assistant' && it.status === 'completed' && it.ms
          ? <span className="row-ms">{(it.ms / 1000).toFixed(1)}s</span> : null}
      </div>
    </div>
  );
}

/** Two-bubble glyph: filled bubble = visible line, outline = hidden. */
function LaneGlyph({ mode }: { mode: DisplayMode }) {
  const srcOn = mode === 'both' || mode === 'source';
  const trOn = mode === 'both' || mode === 'translation';
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden>
      <rect x="1" y="1" width="14" height="5" rx="2" fill={srcOn ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1" />
      <rect x="1" y="8" width="14" height="5" rx="2" fill={trOn ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
