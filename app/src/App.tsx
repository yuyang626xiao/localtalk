import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Volume2, RefreshCw, Zap, Square, Settings, ArrowLeftRight, Users } from 'lucide-react';
import { NativeModelClient } from './lib/native/NativeModelClient';
import type {
  NativeModelInfo, NativeVoiceInfo, ModelProgressMsg, HardwareInfoResultMsg, NativeModelState,
} from './lib/native/nativeProtocol';
import { NativeSession, previewText, type StageInfo } from './session/NativeSession';
import { createPreviewTts, type PreviewVoice } from './lib/native/nativePreviewTts';
import { PcmPlayer } from './audio/PcmPlayer';
import ConversationView from './components/ConversationView';
import DeviceList, { HelpTip } from './components/DeviceList';
import VoiceCloneSection from './components/VoiceCloneSection';
import { getVoice, voicePayload, type VoiceApplyPayload } from './lib/native/nativeVoiceStores';
import type { ConversationItem, DisplayMode } from './conversation/model';
import { nextItemId } from './conversation/model';
import { buildTxt, buildJson, downloadText, exportFilename, type ExportScope } from './conversation/export';
import { useConfig, dirKey, EMPTY_DIR } from './stores/configStore';
import { supportsCustomPrompt, defaultPromptPreview, estimateNativeMemory, formatMemMb } from './lib/native/nativeCatalog';
import './App.css';

const LANGS: { code: string; label: string }[] = [
  { code: '', label: '自动/多语' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'pt', label: '葡萄牙语' },
  { code: 'it', label: '意大利语' },
  { code: 'th', label: '泰语' },
  { code: 'vi', label: '越南语' },
  { code: 'ar', label: '阿拉伯语' },
];

interface PickerProps {
  title: string;
  cards: NativeModelInfo[];
  value: string;
  onChange: (v: string) => void;
  statuses: Record<string, NativeModelState>;
  progress: Record<string, ModelProgressMsg>;
  onDownload: (c: NativeModelInfo) => void;
  warnLang: string;
}

function Picker(p: PickerProps) {
  const cur = p.cards.find((c) => c.id === p.value);
  const st = p.value ? p.statuses[p.value] : undefined;
  const prog = p.value ? p.progress[p.value] : undefined;
  const langWarn = cur && p.warnLang && !cur.languages.some((l) => l === p.warnLang || l === 'all' || l === 'multi');
  return (
    <div className="picker">
      <div className="picker-head">
        <span className="picker-title">{p.title}</span>
        {st === 'ready' && <span className="badge ok">已下载</span>}
        {st === 'absent' && !prog && <span className="badge off">未下载</span>}
      </div>
      <select value={p.value} onChange={(e) => p.onChange(e.target.value)}>
        {p.cards.length === 0 && <option value="">（加载中…）</option>}
        {p.cards.map((c) => (
          <option key={c.id} value={c.id}>
            {cardLabel(c)}{p.statuses[c.id] === 'ready' ? ' ✓' : ''}
          </option>
        ))}
      </select>
      {cur && st === 'absent' && !prog && (
        <button className="btn small" onClick={() => p.onDownload(cur)}>
          下载模型（约 {fmtBytes(cur.sizeBytes || 0)}）
        </button>
      )}
      {prog && (
        <div className="prog">
          <div className="prog-bar" style={{ width: `${prog.total ? Math.min(100, (prog.downloaded / prog.total) * 100) : 5}%` }} />
          <span className="prog-txt">{fmtBytes(prog.downloaded)} / {fmtBytes(prog.total)}</span>
        </div>
      )}
      {langWarn && <div className="hint-warn">当前模型语言表未列出所选语言，识别/合成可能受限。</div>}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!n) return '?';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

function cardLabel(c: NativeModelInfo): string {
  // Name first: the native <select> typeahead matches from the start of the
  // option text — a ★/· prefix would make the model unsearchable by keyboard.
  const clone = c.kind === 'tts' && c.voice?.custom === 'clip' ? ' 可克隆' : '';
  return `${c.name} (${fmtBytes(c.sizeBytes || 0)})${clone}${c.recommended ? ' ★推荐' : ''}`;
}

/** A TTS card that can only speak through a cloned reference clip (no named
 *  presets at all: MOSS-TTS-Nano, Qwen3-TTS, OmniVoice, IndexTTS 2.5…).
 *  For these the stored voiceSource (default 'preset') is meaningless — the
 *  EFFECTIVE mode is always clone. */
function isCloneOnly(c?: NativeModelInfo): boolean {
  return !!c && c.voice?.custom === 'clip' && c.voice?.builtin !== 'named';
}

// Chromium on Windows surfaces the system's "Default" and "Communications"
// ROLE endpoints as extra rows that alias the real device behind them. The
// 系统默认 first row already covers the default role, so the aliases can be
// hidden for a cleaner list (a selected alias always stays visible).
const ROLE_ALIAS_RE = /^(Default|Communications)\s*-\s/;

function pickRecommended(cards: NativeModelInfo[], langs: string[]): NativeModelInfo | undefined {
  const fitting = cards.filter((c) => !langs.length || langs.every((l) => !l || c.languages.includes(l) || c.languages.includes('all') || c.languages.includes('multi')));
  const pool = fitting.length ? fitting : cards;
  return pool.find((c) => c.recommended) || pool[0];
}

function Slider(props: { label: string; min: number; max: number; step: number; value: number; suffix?: string; fmt?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <label>{props.label}<span className="val">{props.fmt ? props.fmt(props.value) : props.value.toFixed(2)}{props.suffix || ''}</span></label>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))} />
    </div>
  );
}

export default function App() {
  const [hw, setHw] = useState<HardwareInfoResultMsg | null>(null);
  const [asrCards, setAsrCards] = useState<NativeModelInfo[]>([]);
  const [trCards, setTrCards] = useState<NativeModelInfo[]>([]);
  const [ttsCards, setTtsCards] = useState<NativeModelInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, NativeModelState>>({});
  const [progress, setProgress] = useState<Record<string, ModelProgressMsg>>({});
  const [voices, setVoices] = useState<NativeVoiceInfo[]>([]);

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [statusLine, setStatusLine] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [listening, setListening] = useState(false);   // session open (mic live)
  const [pttHeld, setPttHeld] = useState(false);        // ptt key window open
  const [busy, setBusy] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);

  const cfg = useConfig();
  const dir = cfg.dirs[dirKey(cfg.sourceLang, cfg.targetLang)] || EMPTY_DIR;
  // 对方链路用反方向（en→zh）；反方向没单独选模型时回退到同一张多语言卡。
  const pDir = cfg.dirs[dirKey(cfg.targetLang, cfg.sourceLang)] || EMPTY_DIR;
  const pAsrModel = pDir.asrModel || dir.asrModel;
  const pTrModel = pDir.trModel || dir.trModel;
  // device-list trim honoring the 精简列表 switch (selected alias never disappears)
  const trimDevs = (list: MediaDeviceInfo[], sel: string) =>
    cfg.compactDevices ? list.filter((d) => !ROLE_ALIAS_RE.test(d.label) || d.deviceId === sel) : list;
  // The TTS card of THIS direction: voice capability (clone? required?) rides
  // on it from the sidecar catalog. A ref lets buildLane read it without
  // joining engineKey (voice choice is applied live, never rebuilds engines).
  const ttsCard = ttsCards.find((c) => c.id === dir.ttsModel);
  const ttsCardRef = useRef(ttsCard);
  ttsCardRef.current = ttsCard;

  const modelsRef = useRef<NativeModelClient | null>(null);
  const sessionRef = useRef<NativeSession | null>(null);
  const pSessionRef = useRef<NativeSession | null>(null);
  const openUserIdRef = useRef<string | null>(null);
  const openTrIdRef = useRef<string | null>(null);
  const pOpenUserIdRef = useRef<string | null>(null);
  const pOpenTrIdRef = useRef<string | null>(null);
  const stagesARef = useRef<StageInfo[]>([]);
  const stagesBRef = useRef<StageInfo[]>([]);

  // ---- audio devices ----------------------------------------------------------
  const [inDevs, setInDevs] = useState<MediaDeviceInfo[]>([]);
  const [outDevs, setOutDevs] = useState<MediaDeviceInfo[]>([]);
  const [devLoading, setDevLoading] = useState(false);
  const micLvlRef = useRef<HTMLSpanElement>(null);
  const ttsLvlRef = useRef<HTMLSpanElement>(null);

  const scanDevices = useCallback(async (unlock: boolean) => {
    setDevLoading(true);
    try {
      // Labels are blank until mic permission was granted in this page session;
      // a brief getUserMedia unlocks them (Electron auto-grants). Never while a
      // session mic is live — that would double-open the device.
      if (unlock && !sessionRef.current?.micOpen && !pSessionRef.current?.micOpen) {
        const st = await navigator.mediaDevices.getUserMedia({ audio: true });
        st.getTracks().forEach((t) => t.stop());
      }
      const ds = await navigator.mediaDevices.enumerateDevices();
      setInDevs(ds.filter((d) => d.kind === 'audioinput'));
      setOutDevs(ds.filter((d) => d.kind === 'audiooutput'));
    } catch { /* enumerate without labels */ }
    finally { setTimeout(() => setDevLoading(false), 350); }   // let the spin finish visibly
  }, []);

  useEffect(() => {
    void scanDevices(true);
    const h = () => void scanDevices(false);
    navigator.mediaDevices.addEventListener('devicechange', h);
    return () => navigator.mediaDevices.removeEventListener('devicechange', h);
  }, [scanDevices]);

  // Control-bar level meters (Sokuji's activity chips): rAF, direct DOM writes.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = sessionRef.current;
      const ps = pSessionRef.current;
      // mic chip: my lane while it exists, otherwise the participant lane's source
      const mic = s?.micOpen ? s.micLevel() : (ps?.micLevel() ?? 0);
      if (micLvlRef.current) micLvlRef.current.style.width = `${Math.round(mic * 100)}%`;
      if (ttsLvlRef.current) ttsLvlRef.current.style.width = `${Math.round((s?.player.level() ?? 0) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pushError = useCallback((e: string) => {
    setErrors((prev) => [...prev.slice(-4), e]);
    setTimeout(() => setErrors((prev) => prev.filter((x) => x !== e)), 12000);
  }, []);

  // ---- sidecar bring-up -------------------------------------------------------
  useEffect(() => {
    const mc = new NativeModelClient();
    modelsRef.current = mc;
    let dead = false;
    (async () => {
      try {
        setStatusLine('正在启动本地引擎（首次约需数秒）…');
        const h = await mc.hardwareInfo();
        if (dead) return;
        setHw(h);
        const [a, t, s] = await Promise.all([
          mc.modelsCatalog(undefined, 'asr'),
          mc.modelsCatalog(undefined, 'translate'),
          mc.modelsCatalog(undefined, 'tts'),
        ]);
        if (dead) return;
        setAsrCards(a); setTrCards(t); setTtsCards(s);
        const st = await mc.status([...a, ...t, ...s].map((c) => c.id));
        if (dead) return;
        setStatuses(st);
        setStatusLine('引擎连接正常');
      } catch (e) {
        // StrictMode double-mount: cleanup disposes the first client while its
        // in-flight RPCs are pending, so the rejected 'native host disconnected'
        // belongs to a dead instance — never surface it. (The second mount owns
        // the live connection.)
        if (dead) return;
        pushError(`无法连接本地引擎：${e instanceof Error ? e.message : String(e)}`);
        setStatusLine('引擎未就绪');
      }
    })();
    return () => { dead = true; mc.dispose(); };
  }, [pushError]);

  // sensible per-direction defaults once the catalog lands
  useEffect(() => {
    if (!asrCards.length && !trCards.length && !ttsCards.length) return;
    const patch: Record<string, string> = {};
    if (asrCards.length && !dir.asrModel) patch.asrModel = pickRecommended(asrCards, [cfg.sourceLang])?.id || '';
    if (trCards.length && !dir.trModel) patch.trModel = pickRecommended(trCards, [cfg.sourceLang, cfg.targetLang])?.id || '';
    if (ttsCards.length && !dir.ttsModel) patch.ttsModel = pickRecommended(ttsCards, [cfg.targetLang])?.id || '';
    if (Object.keys(patch).length) cfg.patchDir(patch);
  }, [asrCards, trCards, ttsCards, cfg.sourceLang, cfg.targetLang]); // eslint-disable-line react-hooks/exhaustive-deps

  // TTS voices follow the chosen model of the CURRENT direction
  useEffect(() => {
    let dead = false;
    (async () => {
      if (!dir.ttsModel) { setVoices([]); return; }
      try {
        const vs = await modelsRef.current?.listTtsVoices(dir.ttsModel) || [];
        if (!dead) {
          setVoices(vs);
          if (!dir.ttsVoice && vs.length) cfg.patchDir({ ttsVoice: vs.find((v) => v.default)?.name || vs[0].name });
        }
      } catch { if (!dead) setVoices([]); }
    })();
    return () => { dead = true; };
  }, [dir.ttsModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshStatuses = useCallback(async () => {
    const ids = [...asrCards, ...trCards, ...ttsCards].map((c) => c.id);
    if (ids.length) { try { setStatuses(await modelsRef.current?.status(ids) || {}); } catch { /* toast path */ } }
  }, [asrCards, trCards, ttsCards]);

  const downloadCard = useCallback(async (card: NativeModelInfo) => {
    const model = modelsRef.current;
    if (!model) return;
    setProgress((p) => ({ ...p, [card.id]: { type: 'model_progress', model: card.id, downloaded: 0, total: card.sizeBytes || 0 } }));
    try {
      let repo: string | undefined;
      if (card.variants?.length) {
        const rec = card.variants.find((v) => v.recommended && v.supported) || card.variants.find((v) => v.supported) || card.variants[0];
        repo = rec.repo;
      }
      const st = await model.download(card.id, (pr) => setProgress((p) => ({ ...p, [card.id]: pr })), repo);
      if (st === 'ready') await refreshStatuses();
    } catch (e) {
      pushError(`下载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress((p) => { const n = { ...p }; delete n[card.id]; return n; });
    }
  }, [refreshStatuses, pushError]);

  // ---- settings panel: drag-resize + collapse ---------------------------------
  const [dragW, setDragW] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const panelW = Math.min(640, Math.max(260, dragW ?? cfg.panel.width));

  const onHandleDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: cfg.panel.width };
    setDragW(cfg.panel.width);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    // panel sits on the right: dragging LEFT grows it
    setDragW(Math.min(640, Math.max(260, dragRef.current.startW + (dragRef.current.startX - e.clientX))));
  };
  const onHandleUp = () => {
    if (dragRef.current && dragW != null && dragW !== cfg.panel.width) cfg.patchPanel({ width: dragW });
    dragRef.current = null;
    setDragW(null);
  };

  // ---- session lifecycle -------------------------------------------------------
  const cfgKeyRef = useRef('');
  const pCfgKeyRef = useRef('');
  const engineKey = JSON.stringify([
    cfg.sourceLang, cfg.targetLang, dir.asrModel, dir.trModel, dir.ttsModel, dir.ttsVoice,
    cfg.speak, cfg.mode, cfg.channelMode, cfg.vad, cfg.audio.inputDeviceId,
  ]);
  const pEngineKey = JSON.stringify([
    cfg.channelMode, cfg.targetLang, cfg.sourceLang, pAsrModel, pTrModel,
    cfg.vad, cfg.audio.participantDeviceId,
  ]);

  // One factory for both lanes. 'participant' = Sokuji's 对方链路: the OTHER
  // party's audio (loopback device) → reverse-direction ASR+translate → stream.
  // It runs against its own sidecar process (cfg.lane) because the engines are
  // process singletons — two directions cannot share one process.
  const buildLane = useCallback(async (lane: 'speaker' | 'participant'): Promise<NativeSession | null> => {
    const isP = lane === 'participant';
    // Read the FRESHEST store at build time: the callback closure can lag behind
    // live-knob changes (ttsSpeed/prompt are not in engineKey by design).
    const c = useConfig.getState();
    const d = c.dirs[dirKey(c.sourceLang, c.targetLang)] || EMPTY_DIR;
    const pd = c.dirs[dirKey(c.targetLang, c.sourceLang)] || EMPTY_DIR;
    const ref = isP ? pSessionRef : sessionRef;
    const keyRef = isP ? pCfgKeyRef : cfgKeyRef;
    const key = isP ? pEngineKey : engineKey;
    const cur = ref.current;
    if (cur && keyRef.current === key) return cur;
    if (cur) { cur.dispose(); ref.current = null; }

    const src = isP ? c.targetLang : c.sourceLang;
    const dst = isP ? c.sourceLang : c.targetLang;
    const asrModel = isP ? (pd.asrModel || d.asrModel) : d.asrModel;
    const trModel = isP ? (pd.trModel || d.trModel) : d.trModel;
    const speak = !isP && c.speak;
    const ttsModel = speak ? d.ttsModel : '';
    if (!asrModel || !trModel) { pushError(isP ? '对方链路缺少识别/翻译模型' : '请先选择识别与翻译模型'); return null; }
    if (isP && !c.audio.participantDeviceId) {
      pushError('请先在「音频设备 → 对方音频源」选择对方的声音来源（如 CABLE Output / 立体声混音）');
      return null;
    }
    // 开始会话前必须已下载：否则 sidecar 离线加载会抛出晦涩的 HF 缓存错误。
    const need = [asrModel, trModel, ...(speak && ttsModel ? [ttsModel] : [])];
    const missing = need.filter((id) => statuses[id] !== 'ready');
    if (missing.length) {
      const names = missing.map((id) => [...asrCards, ...trCards, ...ttsCards].find((c) => c.id === id)?.name || id).join('、');
      pushError(`模型还没下载：${names} —— 在右侧「本地模型」里点「下载模型」，完成后再开始会话`);
      return null;
    }

    // Clone voice: resolve the library clip NOW (fresh id from the store) so
    // the session carries it into prepare(). Voice changes after that are
    // applied live (applyVoice), never via engine rebuild.
    const tc = ttsCardRef.current;
    const voiceMode = !isP && speak ? (isCloneOnly(tc) ? 'clone' : (d.voiceSource ?? 'preset')) : 'preset';
    let ttsClone: VoiceApplyPayload | undefined;
    if (voiceMode === 'clone' && d.cloneVoiceId != null) {
      const stored = await getVoice(d.cloneVoiceId);
      if (stored) ttsClone = voicePayload(stored);
    }
    if (voiceMode === 'clone' && tc?.voice?.required && !ttsClone) {
      pushError('该模型必须使用克隆音色：请先在「音色克隆」里录制/导入并选中一段参考音频');
      return null;
    }

    const uRef = isP ? pOpenUserIdRef : openUserIdRef;
    const tRef = isP ? pOpenTrIdRef : openTrIdRef;
    const tag = isP ? 'participant' as const : 'speaker' as const;
    const s = new NativeSession(
      {
        lane,
        sourceLang: src, targetLang: dst,
        asrModel, translateModel: trModel,
        ttsModel, ttsVoice: speak && !ttsClone ? d.ttsVoice : undefined, ttsClone,
        speak, mode: isP ? 'auto' : c.mode, vad: c.vad,
        translatePrompt: c.promptMode === 'advanced' ? c.prompt : '',
        ttsSpeed: c.ttsSpeed,
        audio: isP
          // their audio is already digital (loopback) — no denoise, no passthrough
          ? { inputDeviceId: c.audio.participantDeviceId, outputDeviceId: '', noiseMode: 'off', passthrough: false }
          : { ...c.audio },
      },
      {
        onStatus: (m) => setStatusLine(isP ? `对方：${m}` : m),
        onStages: (ss) => {
          (isP ? stagesBRef : stagesARef).current = isP ? ss.map((x) => ({ ...x, label: `对方·${x.label}` })) : ss;
          setStages([...stagesARef.current, ...stagesBRef.current]);
        },
        onError: pushError,
        onSourcePartial: (t) => {
          if (!t) return;
          const id = uRef.current;
          if (id) setItems((p) => p.map((i) => (i.id === id ? { ...i, text: t } : i)));
          else {
            const it: ConversationItem = { id: nextItemId('u'), role: 'user', type: 'message', status: 'in_progress', source: tag, createdAt: Date.now(), text: t, srcLang: src, dstLang: dst };
            uRef.current = it.id;
            setItems((p) => [...p, it]);
          }
        },
        onSourceFinal: (t) => {
          const id = uRef.current;
          // Offline ASR never sends partials — with no open row the final must
          // CREATE one, or the user's own speech silently vanishes from the
          // stream (only the translation would appear).
          if (id) setItems((p) => p.map((i) => (i.id === id ? { ...i, text: t, status: 'completed' } : i)));
          else setItems((p) => [...p, { id: nextItemId('u'), role: 'user', type: 'message', status: 'completed', source: tag, createdAt: Date.now(), text: t, srcLang: src, dstLang: dst }]);
          uRef.current = null;
        },
        onTranslatePartial: (t) => {
          if (!t) return;
          const id = tRef.current;
          if (id) setItems((p) => p.map((i) => (i.id === id ? { ...i, text: t } : i)));
          else {
            const it: ConversationItem = { id: nextItemId('t'), role: 'assistant', type: 'message', status: 'in_progress', source: tag, createdAt: Date.now(), text: t, srcLang: src, dstLang: dst };
            tRef.current = it.id;
            setItems((p) => [...p, it]);
          }
        },
        onTranslated: (srcTxt, dstTxt, ms) => {
          const id = tRef.current;
          if (id) setItems((p) => p.map((i) => (i.id === id ? { ...i, text: dstTxt, status: 'completed', ms } : i)));
          else setItems((p) => [...p, { id: nextItemId('t'), role: 'assistant', type: 'message', status: 'completed', source: tag, createdAt: Date.now(), text: dstTxt, srcLang: src, dstLang: dst, ms }]);
          tRef.current = null;
        },
      },
    );
    ref.current = s;
    keyRef.current = key;
    setStatusLine(isP ? '对方：准备引擎…' : '准备引擎（首次加载模型会较慢）…');
    setBusy(true);
    try {
      await s.prepare();
      return s;
    } catch (e) {
      s.dispose();
      ref.current = null;
      pushError(`${isP ? '对方链路' : '引擎'}启动失败：${e instanceof Error ? e.message : String(e)}`);
      setStatusLine('引擎未就绪');
      return null;
    } finally {
      setBusy(false);
    }
  }, [engineKey, pEngineKey, pushError, statuses]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Voice preview (Sokuji nativePreviewTts semantics) ────────────────────
  // Its OWN sidecar connection: a live session's TTS engine must not be
  // evicted by a preview (engines are process singletons), so when a session
  // already holds TTS we reuse it; otherwise this handle loads the model on
  // demand, stays warm across clicks, and releases on engine release.
  const previewTtsRef = useRef<ReturnType<typeof createPreviewTts> | null>(null);
  const previewPlayerRef = useRef<PcmPlayer | null>(null);

  const closePreview = useCallback(() => {
    previewTtsRef.current?.close();
    previewTtsRef.current = null;
    previewPlayerRef.current?.close();
    previewPlayerRef.current = null;
  }, []);

  const doPreview = useCallback(async () => {
    const c = useConfig.getState();
    const d = c.dirs[dirKey(c.sourceLang, c.targetLang)] || EMPTY_DIR;
    if (!d.ttsModel) throw new Error('还没有选择 TTS 模型');
    if (c.speak && sessionRef.current?.prepared) { await sessionRef.current.preview(); return; }
    const card = ttsCardRef.current;
    const mode = isCloneOnly(card) ? 'clone' : (d.voiceSource ?? 'preset');
    let voice: PreviewVoice | undefined;
    if (mode === 'clone' && d.cloneVoiceId != null) {
      const stored = await getVoice(d.cloneVoiceId);
      if (stored) voice = { kind: 'clip', audio: new Float32Array(stored.audio), sampleRate: stored.sampleRate, refText: stored.transcript };
    } else if (d.ttsVoice) {
      voice = { kind: 'name', name: d.ttsVoice };
    }
    if (!voice) throw new Error(mode === 'clone' ? '先在列表里选中一段克隆音色，再试听' : '该模型需要先选择内置音色');
    if (!previewTtsRef.current) previewTtsRef.current = createPreviewTts();
    if (!previewPlayerRef.current) previewPlayerRef.current = new PcmPlayer();
    const player = previewPlayerRef.current;
    player.volume = c.volume;
    if (c.audio.outputDeviceId) await player.setSinkId(c.audio.outputDeviceId);
    const r = await previewTtsRef.current.synthesize({
      modelId: d.ttsModel, language: c.targetLang,
      text: previewText(c.targetLang), speed: c.ttsSpeed, voice,
    });
    player.play(r.audio);
  }, []);

  useEffect(() => () => { sessionRef.current?.dispose(); sessionRef.current = null; closePreview(); setListening(false); setPttHeld(false); }, [engineKey, closePreview]);
  useEffect(() => () => { pSessionRef.current?.dispose(); pSessionRef.current = null; setListening(false); setPttHeld(false); }, [pEngineKey]);

  // live knobs — no engine reload
  useEffect(() => {
    const p = cfg.promptMode === 'advanced' ? cfg.prompt : '';
    sessionRef.current?.setPrompt(p);
    pSessionRef.current?.setPrompt(p);   // the prompt governs both directions
  }, [cfg.prompt, cfg.promptMode]);

  // voice source / clip / preset changes swap the LIVE voice (one set_voice
  // round-trip) — engines stay loaded.
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !cfg.speak) return;
    void (async () => {
      try {
        const mode = isCloneOnly(ttsCardRef.current) ? 'clone' : (dir.voiceSource ?? 'preset');
        let clone: VoiceApplyPayload | undefined;
        if (mode === 'clone' && dir.cloneVoiceId != null) {
          const v = await getVoice(dir.cloneVoiceId);
          if (v) clone = voicePayload(v);
        }
        await s.applyVoice(clone ? { clone } : { preset: dir.ttsVoice });
      } catch (e) {
        pushError(`切换音色失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [dir.voiceSource, dir.cloneVoiceId, dir.ttsVoice, cfg.speak, ttsCard?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sessionRef.current?.setSpeed(cfg.ttsSpeed); }, [cfg.ttsSpeed]);
  useEffect(() => { sessionRef.current?.setVolume(cfg.volume); }, [cfg.volume]);
  useEffect(() => { sessionRef.current?.setSpeak(cfg.speak); }, [cfg.speak]);
  useEffect(() => { void sessionRef.current?.setNoiseMode(cfg.audio.noiseMode); }, [cfg.audio.noiseMode]);
  useEffect(() => { sessionRef.current?.setPassthrough(cfg.audio.passthrough); }, [cfg.audio.passthrough]);
  useEffect(() => { void sessionRef.current?.setOutputDevice(cfg.audio.outputDeviceId); }, [cfg.audio.outputDeviceId]);

  // ---- controls -----------------------------------------------------------------
  const ensureLane = useCallback(async (lane: 'speaker' | 'participant'): Promise<NativeSession | null> => {
    const isP = lane === 'participant';
    const cur = isP ? pSessionRef.current : sessionRef.current;
    const keyOk = isP ? pCfgKeyRef.current === pEngineKey : cfgKeyRef.current === engineKey;
    if (cur && keyOk) return cur;
    return await buildLane(lane);
  }, [buildLane, engineKey, pEngineKey]);

  const pttDown = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !s.micOpen) { setStatusLine('请先点「开始会话」，再按住说话'); return; }
    setPttHeld(true);
    await s.pttDown();
  }, []);

  const pttUp = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !s.pttHeld) { setPttHeld(false); return; }
    setPttHeld(false);
    await s.pttUp();
  }, []);

  // 开始会话 = start every lane the channel mode asks for, in parallel
  // (two sidecar processes load their models concurrently).
  const toggleSession = useCallback(async () => {
    if (listening) {
      try {
        await Promise.all([
          sessionRef.current?.stopSession(),
          pSessionRef.current?.stopSession(),
        ]);
      } catch (e) {
        pushError(`${e instanceof Error ? e.message : String(e)}`);
      }
      setListening(false); setPttHeld(false);
      return;
    }
    const wantA = cfg.channelMode !== 'other';
    const wantB = cfg.channelMode !== 'me';
    const [a, b] = await Promise.all([
      wantA ? ensureLane('speaker') : Promise.resolve(null),
      wantB ? ensureLane('participant') : Promise.resolve(null),
    ]);
    if ((wantA && !a) || (wantB && !b)) return;   // a lane failed — its error already surfaced
    try {
      await Promise.all([a?.startSession(), b?.startSession()]);
      setListening(true);
    } catch (e) {
      pushError(`${e instanceof Error ? e.message : String(e)}`);
    }
  }, [listening, cfg.channelMode, ensureLane, pushError]);

  useEffect(() => {
    if (cfg.mode !== 'ptt' || cfg.channelMode === 'other') return undefined;
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault(); void pttDown();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) void pttUp();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, [pttDown, pttUp, cfg.mode]);

  // ---- storage / estimates --------------------------------------------------------
  const catalogMap = useMemo(() => {
    const m: Record<string, NativeModelInfo> = {};
    for (const c of [...asrCards, ...trCards, ...ttsCards]) m[c.id] = c;
    return m;
  }, [asrCards, trCards, ttsCards]);

  const readyCards = useMemo(
    () => [...asrCards, ...trCards, ...ttsCards].filter((c) => statuses[c.id] === 'ready'),
    [asrCards, trCards, ttsCards, statuses],
  );
  const usedMb = Math.round(readyCards.reduce((acc, c) => acc + (c.sizeBytes || 0), 0) / 1_048_576);

  const est = useMemo(() => estimateNativeMemory(
    [{ id: dir.asrModel }, { id: dir.trModel }, { id: cfg.speak ? dir.ttsModel : '' }], catalogMap),
  [dir.asrModel, dir.trModel, dir.ttsModel, cfg.speak, catalogMap]);
  // 双链路时对方 lane 的 ASR+MT 也占一份显存（无反向 TTS）
  const pEst = useMemo(() => cfg.channelMode === 'me'
    ? { vramMb: 0, ramMb: 0 }
    : estimateNativeMemory([{ id: pAsrModel }, { id: pTrModel }], catalogMap),
  [cfg.channelMode, pAsrModel, pTrModel, catalogMap]);
  const actualMb = stages.reduce((acc, s) => acc + (s.memoryBytes || 0), 0) / 1_048_576;
  const memChip = actualMb > 0
    ? `显存/内存实测 ${formatMemMb(Math.round(actualMb))}`
    : (est.vramMb + pEst.vramMb + est.ramMb + pEst.ramMb > 0 ? `预估 VRAM ${formatMemMb(est.vramMb + pEst.vramMb)} · RAM ${formatMemMb(est.ramMb + pEst.ramMb)}` : '');

  const deleteModel = useCallback(async (card: NativeModelInfo) => {
    const m = modelsRef.current;
    if (!m) return;
    try {
      const freed = await m.delete(card.id);
      pushError(`${card.name} 已删除，释放 ${fmtBytes(freed)}`);
      await refreshStatuses();
    } catch (e) {
      pushError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshStatuses, pushError]);

  const onExport = useCallback((scope: ExportScope, format: 'txt' | 'json' | 'clipboard') => {
    const meta = {
      sourceLang: cfg.sourceLang || 'auto', targetLang: cfg.targetLang,
      models: [dir.asrModel, dir.trModel, dir.ttsModel].filter(Boolean),
    };
    if (format === 'txt') downloadText(exportFilename('txt'), buildTxt(items, scope, meta), 'text/plain');
    else if (format === 'json') downloadText(exportFilename('json'), buildJson(items, scope, meta), 'application/json');
    else void navigator.clipboard.writeText(buildTxt(items, scope, meta));
  }, [items, cfg.sourceLang, cfg.targetLang, dir]);

  const releaseEngines = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    pSessionRef.current?.dispose();
    pSessionRef.current = null;
    closePreview();
    stagesARef.current = [];
    stagesBRef.current = [];
    setStages([]);
    setListening(false);
    setStatusLine('已释放引擎（模型仍在缓存，下次更快）');
  }, [closePreview]);

  const promptSupported = supportsCustomPrompt(dir.trModel);

  return (
    <div className="app">
      <header>
        <div className="brand">LocalTalk<span className="sub">本地实时语音翻译</span></div>
        <div className="hw">
          {hw && <span className="chip">{hw.lane === 'gpu' ? 'GPU 通道' : 'CPU 通道'}</span>}
          {hw && <span className="chip dim">{hw.cpuCores} 核</span>}
          {hw?.gpus.map((g) => <span key={g.name} className="chip">{g.name.replace(/^NVIDIA /, '')} {g.vramMb}MB</span>)}
          {memChip && <span className="chip">{memChip}</span>}
          <button
            className={`tool-btn panel-toggle ${cfg.panel.open ? 'on' : ''}`}
            title={cfg.panel.open ? '收起设置栏' : '展开设置栏'}
            onClick={() => cfg.patchPanel({ open: !cfg.panel.open })}
          >
            <Settings size={14} /> 设置
          </button>
        </div>
      </header>
      <div className="main">
        {cfg.panel.open && (
        <aside className="panel" style={{ width: panelW, minWidth: panelW }}>
          <div
            className={`resize-handle${dragW != null ? ' dragging' : ''}`}
            onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}
            onDoubleClick={() => { setDragW(null); cfg.patchPanel({ width: 320 }); }}
            title="拖动调整宽度 · 双击恢复默认"
          />
          <div className="section-title">语言方向</div>
          <div className="lang-row">
            <select value={cfg.sourceLang} onChange={(e) => cfg.patch({ sourceLang: e.target.value })} disabled={listening}>
              {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <button className="btn swap" disabled={listening} onClick={() => cfg.patch({ sourceLang: cfg.targetLang, targetLang: cfg.sourceLang })} title="交换方向">⇄</button>
            <select value={cfg.targetLang} onChange={(e) => cfg.patch({ targetLang: e.target.value })} disabled={listening}>
              {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>

          <div className="section-title">语音模式</div>
          <div className="seg">
            <button className={cfg.mode === 'ptt' ? 'on' : ''} disabled={listening} onClick={() => cfg.patch({ mode: 'ptt' })}>按住说话</button>
            <button className={cfg.mode === 'auto' ? 'on' : ''} disabled={listening} onClick={() => cfg.patch({ mode: 'auto' })}>自动（VAD）</button>
          </div>
          {cfg.mode === 'auto' && (
            <div className="hint-warn">自动模式由本机 VAD 断句：说完停顿约 {cfg.vad.minSilence.toFixed(2)} 秒后自动识别并翻译。</div>
          )}
          {cfg.mode === 'ptt' && (
            <div className="dim-sm">按住说话模式：先点底部「开始会话」加载引擎并开启麦克风，然后按住按钮或空格说话、松手即译。</div>
          )}
          {cfg.channelMode !== 'me' && (
            <div className="dim-sm">语音模式只作用于「我」链路；「对方」链路始终由 VAD 自动断句。</div>
          )}

          <div className="section-title">音频设备</div>
          <label className="row-check">
            <input type="checkbox" checked={cfg.compactDevices}
              onChange={(e) => cfg.patch({ compactDevices: e.target.checked })} />
            精简列表（隐藏 Default - / Communications - 角色别名行）
          </label>

          <div className="dev-section">
            <h3>
              <Mic size={16} />
              <span>麦克风</span>
              <HelpTip text="选择拾取你声音的输入设备。切换会重建识别引擎（聆听中不可改）。" />
              <button className="section-refresh-button" title="重新扫描设备" onClick={() => void scanDevices(true)} disabled={devLoading}>
                <RefreshCw size={14} className={devLoading ? 'spinning' : ''} />
              </button>
            </h3>
            <DeviceList
              devices={trimDevs(inDevs, cfg.audio.inputDeviceId)}
              kind="input"
              selectedId={cfg.audio.inputDeviceId}
              disabled={listening}
              onSelect={(id) => cfg.patchAudio({ inputDeviceId: id })}
            />
            <div className="field noise-suppression-control">
              <label>噪声抑制</label>
              <div className="seg">
                {(['off', 'standard', 'enhanced'] as const).map((m) => (
                  <button key={m} className={cfg.audio.noiseMode === m ? 'on' : ''}
                    onClick={() => cfg.patchAudio({ noiseMode: m })}>
                    {m === 'off' ? '关闭' : m === 'standard' ? '标准' : '增强'}
                  </button>
                ))}
              </div>
              <span className="dim-sm">标准 = RNNoise（轻量）；增强 = GTCRN 神经网络，效果更好、CPU 略高。</span>
            </div>
            <label className="row-check">
              <input type="checkbox" checked={cfg.audio.passthrough}
                onChange={(e) => cfg.patchAudio({ passthrough: e.target.checked })} />
              原声直通（30% 监听自己的声音，建议戴耳机）
            </label>
          </div>

          {cfg.channelMode !== 'me' && (
            <div className="dev-section">
              <h3>
                <Users size={16} />
                <span>对方音频源</span>
                <HelpTip text="会议软件播放给对方声音的输出设备。选它作为来源即可翻译对方的话，例如 CABLE Output 或立体声混音。" />
                <button className="section-refresh-button" title="重新扫描设备" onClick={() => void scanDevices(true)} disabled={devLoading}>
                  <RefreshCw size={14} className={devLoading ? 'spinning' : ''} />
                </button>
              </h3>
              <DeviceList
                devices={trimDevs(inDevs, cfg.audio.participantDeviceId)}
                kind="input"
                selectedId={cfg.audio.participantDeviceId}
                disabled={listening}
                onSelect={(id) => cfg.patchAudio({ participantDeviceId: id })}
              />
              <div className="hint-warn">注意：若该设备拾取的是本机<b>全部</b>播放声，译文朗读也会被它录回去形成自我循环。建议把会议声音单独路由到一条虚拟线缆（如 CABLE Input 收会议声、CABLE Output 作为此处的来源）。</div>
            </div>
          )}

          <div className="dev-section">
            <h3>
              <Volume2 size={16} />
              <span>扬声器（译文朗读）</span>
              <HelpTip text="译文语音的输出设备；原声直通也送到这里。" />
              <button className="section-refresh-button" title="重新扫描设备" onClick={() => void scanDevices(true)} disabled={devLoading}>
                <RefreshCw size={14} className={devLoading ? 'spinning' : ''} />
              </button>
            </h3>
            <DeviceList
              devices={trimDevs(outDevs, cfg.audio.outputDeviceId)}
              kind="output"
              selectedId={cfg.audio.outputDeviceId}
              onSelect={(id) => cfg.patchAudio({ outputDeviceId: id })}
            />
          </div>

          <div className="section-title">本地模型（{cfg.sourceLang || '自动'} → {cfg.targetLang}）</div>
          <Picker title="语音识别 ASR" cards={asrCards} value={dir.asrModel} onChange={(v) => cfg.patchDir({ asrModel: v })}
            statuses={statuses} progress={progress} onDownload={downloadCard} warnLang={cfg.sourceLang} />
          <Picker title="翻译 MT" cards={trCards} value={dir.trModel} onChange={(v) => cfg.patchDir({ trModel: v })}
            statuses={statuses} progress={progress} onDownload={downloadCard} warnLang={cfg.targetLang} />
          <Picker title="语音合成 TTS" cards={ttsCards} value={dir.ttsModel} onChange={(v) => cfg.patchDir({ ttsModel: v, ttsVoice: '' })}
            statuses={statuses} progress={progress} onDownload={downloadCard} warnLang={cfg.targetLang} />

          <div className="section-title">翻译提示词</div>
          <div className={`picker${promptSupported ? '' : ' disabled'}`}>
            <div className="seg">
              <button className={cfg.promptMode === 'simple' ? 'on' : ''} disabled={!promptSupported} onClick={() => cfg.patch({ promptMode: 'simple' })}>快捷</button>
              <button className={cfg.promptMode === 'advanced' ? 'on' : ''} disabled={!promptSupported} onClick={() => cfg.patch({ promptMode: 'advanced' })}>高级</button>
            </div>
            {!promptSupported && (
              <div className="hint-warn">当前翻译模型不支持自定义提示词。请在上方切换到 Qwen 等系列模型后可用。</div>
            )}
            {promptSupported && cfg.promptMode === 'simple' && (
              <div className="preview-box">{defaultPromptPreview(cfg.sourceLang, cfg.targetLang)}</div>
            )}
            {promptSupported && cfg.promptMode === 'advanced' && (
              <>
                <textarea className="prompt-area" rows={4} placeholder="留空则使用默认模板；可写角色/语气/术语表等系统指令…"
                  value={cfg.prompt} onChange={(e) => cfg.patch({ prompt: e.target.value })} />
                <div className="hint-warn">Qwen3 系列会自动追加 /no_think。修改后下一句即时生效。</div>
              </>
            )}
          </div>

          <div className="section-title">语音合成设置</div>
          <div className="picker">
            <Slider label="语速" min={0.5} max={2.0} step={0.1} value={cfg.ttsSpeed} suffix="x"
              fmt={(v) => v.toFixed(1)} onChange={(v) => cfg.patch({ ttsSpeed: v })} />
            {voices.length > 0 && !isCloneOnly(ttsCard) && (dir.voiceSource ?? 'preset') === 'preset' && (
              <div className="field">
                <label>音色</label>
                <select value={dir.ttsVoice} onChange={(e) => cfg.patchDir({ ttsVoice: e.target.value })}>
                  {voices.map((v) => <option key={v.name} value={v.name}>{v.name}{v.language ? ` (${v.language})` : ''}</option>)}
                </select>
              </div>
            )}
            <VoiceCloneSection
              card={ttsCard}
              source={isCloneOnly(ttsCard) ? 'clone' : (dir.voiceSource ?? 'preset')}
              voiceId={dir.cloneVoiceId ?? null}
              micDeviceId={cfg.audio.inputDeviceId}
              micBusy={listening}
              canPreview={!!dir.ttsModel && statuses[dir.ttsModel] === 'ready'}
              onSource={(v) => cfg.patchDir({ voiceSource: v })}
              onVoiceId={(id) => cfg.patchDir({ cloneVoiceId: id })}
              onPreview={doPreview}
            />
          </div>

          <div className="section-title">VAD 断句（自动模式）</div>
          <div className="picker">
            <Slider label="灵敏度阈值" min={0.1} max={0.95} step={0.05} value={cfg.vad.threshold}
              onChange={(v) => cfg.patchVad({ threshold: v })} />
            <Slider label="静音判停（秒）" min={0.05} max={2.0} step={0.05} value={cfg.vad.minSilence}
              fmt={(v) => v.toFixed(2)} onChange={(v) => cfg.patchVad({ minSilence: v })} />
            <Slider label="最短语音（秒）" min={0.05} max={1.0} step={0.05} value={cfg.vad.minSpeech}
              fmt={(v) => v.toFixed(2)} onChange={(v) => cfg.patchVad({ minSpeech: v })} />
          </div>

          <div className="section-title">输出</div>
          <label className="row-check"><input type="checkbox" checked={cfg.speak} onChange={(e) => cfg.patch({ speak: e.target.checked })} /> 朗读译文</label>
          <Slider label="音量" min={0} max={1} step={0.05} value={cfg.volume} onChange={(v) => cfg.patch({ volume: v })} />

          <div className="section-title">存储</div>
          <div className="picker">
            <div className="storage-row" onClick={() => setStorageOpen((v) => !v)}>
              <span>已用：{usedMb} MB（{readyCards.length} 个模型）</span>
              <span className="val">{storageOpen ? '▾' : '▸'}</span>
            </div>
            {storageOpen && (
              <>
                {readyCards.map((c) => (
                  <div key={c.id} className="storage-item">
                    <span className="storage-name">{c.kind === 'asr' ? '🎤' : c.kind === 'tts' ? '🔊' : '🌐'} {c.name}</span>
                    <span className="dim-sm">{fmtBytes(c.sizeBytes || 0)}</span>
                    <button className="btn small" onClick={() => void deleteModel(c)}>删除</button>
                  </div>
                ))}
                {readyCards.length === 0 && <div className="dim-sm">暂无已下载模型</div>}
              </>
            )}
          </div>

          {stages.length > 0 && (
            <>
              <div className="section-title">引擎状态</div>
              <div className="stages">
                {stages.map((s) => (
                  <div key={s.label} className="stage-chip">{s.label} <b>{s.detail}</b>{s.memoryBytes ? ` · ${formatMemMb(Math.round(s.memoryBytes / 1_048_576))}` : ''}</div>
                ))}
              </div>
              <button className="btn small" onClick={releaseEngines}>释放引擎显存</button>
            </>
          )}
        </aside>
        )}

        <section className="stage">
          <ConversationView
            items={items}
            displayMode={cfg.display.mode}
            onDisplayMode={(m) => cfg.patchDisplay({ mode: m })}
            fontSize={cfg.display.fontSize}
            onFontSize={(n) => cfg.patchDisplay({ fontSize: n })}
            compact={cfg.display.compact}
            onCompact={(b) => cfg.patchDisplay({ compact: b })}
            onExport={onExport}
            onClear={() => { setItems([]); openUserIdRef.current = null; openTrIdRef.current = null; }}
            srcLang={cfg.sourceLang || 'auto'}
            dstLang={cfg.targetLang}
          />
          <div className="control-bar">
            <div className="cb-left">
              <span className={`status-dot ${busy ? 'busy' : listening ? 'on' : ''}`} title={statusLine} />
              <div className="seg mini chan">
                <button className={cfg.channelMode === 'me' ? 'on' : ''} disabled={listening} title="只翻译我说的话（麦克风）"
                  onClick={() => cfg.patch({ channelMode: 'me' })}><Mic size={12} /> 我</button>
                <button className={cfg.channelMode === 'other' ? 'on' : ''} disabled={listening} title="只翻译对方的声音（需选对方音频源）"
                  onClick={() => cfg.patch({ channelMode: 'other' })}><Volume2 size={12} /> 对方</button>
                <button className={cfg.channelMode === 'both' ? 'on' : ''} disabled={listening} title="双向：我的声音翻给对方，对方的声音翻给我"
                  onClick={() => cfg.patch({ channelMode: 'both' })}><ArrowLeftRight size={12} /> 两者</button>
              </div>
              <span className="lvl" title="麦克风电平"><i ref={micLvlRef} className="mic" /></span>
              <span className="lvl" title="朗读电平"><i ref={ttsLvlRef} className="tts" /></span>
            </div>
            <div className="cb-center">
              <button className={`main-btn ${listening ? 'stop' : ''}`} disabled={busy} onClick={() => void toggleSession()}>
                {listening ? <><Square size={14} /> 停止会话</> : <><Zap size={16} /> 开始会话</>}
              </button>
              {cfg.mode === 'ptt' && cfg.channelMode !== 'other' && (
                <button
                  className={`hold-btn ${pttHeld ? 'on' : ''}`}
                  disabled={!listening || busy}
                  title={listening ? '按住说话，松手即翻译（也可按住空格）' : '先点「开始会话」加载引擎'}
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); void pttDown(); }}
                  onPointerUp={() => void pttUp()}
                  onPointerCancel={() => void pttUp()}
                  onBlur={() => { if (pttHeld) void pttUp(); }}
                >
                  {busy ? '准备中…' : pttHeld ? '松手翻译' : '按住说话'}
                </button>
              )}
            </div>
            <div className="cb-right">
              <span className="status-txt">{statusLine}</span>
              <span className="dir-label">
                {cfg.channelMode === 'both' ? `${cfg.sourceLang} ⇄ ${cfg.targetLang}`
                  : cfg.channelMode === 'other' ? `${cfg.targetLang} → ${cfg.sourceLang}`
                  : `${cfg.sourceLang || 'auto'} → ${cfg.targetLang}`}
              </span>
            </div>
          </div>
        </section>
      </div>

      <div className="toasts">
        {errors.map((e, i) => <div className="toast" key={i}>{e}</div>)}
      </div>
    </div>
  );
}
