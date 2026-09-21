// Voice-cloning section for the settings panel (Sokuji's NativeVoiceSection
// semantics, re-skinned to LocalTalk's panel dialect). AGPL-3.0 design port.
//
// Drives the IndexedDB clip library (nativeVoiceStores): record from the mic
// or import an audio file, keep 3-20s of clean speech, optionally with its
// transcript (mandatory for qwen3_tts / omnivoice). The chosen clip reaches
// the sidecar as set_voice (binary frame + JSON) via NativeSession.

import { useEffect, useRef, useState } from 'react';
import { AudioLines, Mic, Pencil, Play, Square, Trash2, Upload } from 'lucide-react';
import type { NativeModelInfo } from '../lib/native/nativeProtocol';
import {
  addVoice, clipLimits, deleteVoice, listVoices, normalizePeak, downmixToMono,
  renameVoice, validateVoiceClip, CLIP_ERROR_TEXT,
  type StoredVoiceClip,
} from '../lib/native/nativeVoiceStores';
import { HelpTip } from './DeviceList';

interface Props {
  /** The direction's current TTS card (undefined until the catalog lands). */
  card?: NativeModelInfo;
  source: 'preset' | 'clone';
  voiceId: number | null;
  micDeviceId: string;
  /** Session holds the mic — recording would fight it. */
  micBusy: boolean;
  /** TTS model downloaded: 试听 works (with or without a live session). */
  canPreview: boolean;
  onSource(s: 'preset' | 'clone'): void;
  onVoiceId(id: number | null): void;
  onPreview(): Promise<void>;
}

interface RecState {
  ctx: AudioContext; stream: MediaStream; proc: ScriptProcessorNode; sink: GainNode;
  chunks: Float32Array[]; startedAt: number;
}

function clipSeconds(v: StoredVoiceClip): number {
  return v.audio.byteLength / 4 / v.sampleRate;
}

export default function VoiceCloneSection(p: Props) {
  const voice = p.card?.voice;
  const [voices, setVoices] = useState<StoredVoiceClip[]>([]);
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');
  const recRef = useRef<RecState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const clipCtxRef = useRef<AudioContext | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const cloning = voice?.custom === 'clip';
  const cloneOnly = cloning && voice?.builtin !== 'named';   // qwen3_tts/omnivoice/index_tts2/moss...
  // Clone-only models have no preset to switch TO — the stored source (whose
  // default is 'preset') must not dead-end them out of their own tools.
  const showClone = cloneOnly || p.source === 'clone';
  const limits = clipLimits(p.card?.id);

  const refresh = () => listVoices().then(setVoices).catch(() => undefined);
  useEffect(() => { void refresh(); }, []);

  // stop the recorder on unmount
  useEffect(() => () => { if (recRef.current) stopRecord(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function capture(clip: Float32Array, sampleRate: number, name: string) {
    setError('');
    if (voice?.transcriptRequired && !transcript.trim()) {
      setError('该模型需要参考音频的文字稿：请在上方输入这段音频说的话，再保存');
      return false;
    }
    const bad = validateVoiceClip(clip, sampleRate, limits.max, limits.min);
    if (bad) { setError(CLIP_ERROR_TEXT[bad]); return false; }
    try {
      const saved = await addVoice(name, normalizePeak(clip), sampleRate, transcript.trim() || undefined);
      setTranscript('');
      await refresh();
      p.onVoiceId(saved.id);
      if (p.source !== 'clone') p.onSource('clone');
      return true;
    } catch (e) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async function startRecord() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: p.micDeviceId ? { exact: p.micDeviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const sink = ctx.createGain();           // silent leg: keeps the processor
      sink.gain.value = 0;                     // firing without hearing ourselves
      const chunks: Float32Array[] = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
      recRef.current = { ctx, stream, proc, sink, chunks, startedAt: Date.now() };
      setElapsed(0);
      timerRef.current = setInterval(() => {
        const s = (Date.now() - (recRef.current?.startedAt || 0)) / 1000;
        setElapsed(s);
        if (s >= limits.max) void stopRecord(true);   // auto-stop at the model cap
      }, 100);
    } catch (e) {
      setError(`麦克风打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function stopRecord(save: boolean) {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    clearInterval(timerRef.current);
    const total = rec.chunks.reduce((n, c) => n + c.length, 0);
    const mono = new Float32Array(total);
    let off = 0;
    for (const c of rec.chunks) { mono.set(c, off); off += c.length; }
    rec.proc.disconnect(); rec.sink.disconnect(); rec.stream.getTracks().forEach((t) => t.stop());
    await rec.ctx.close();
    setElapsed(0);
    if (save) await capture(mono, rec.ctx.sampleRate, `克隆音色 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  }

  const recording = !!recRef.current;

  async function onFile(f: File) {
    setError('');
    try {
      const ctx = new AudioContext();
      let buf: AudioBuffer;
      try { buf = await ctx.decodeAudioData(await f.arrayBuffer()); } finally { void ctx.close(); }
      await capture(downmixToMono(buf), buf.sampleRate, f.name.replace(/\.[^./\\]+$/, '') || '导入音色');
    } catch {
      setError('无法解码这个音频文件（试试 WAV/MP3）');
    }
  }

  /** Play the RAW stored clip (your recorded voice itself, not a synthesis) —
   *  the "did the recording capture me clearly?" check, fully local. */
  async function playRaw(v: StoredVoiceClip) {
    setError('');
    try {
      const ctx = clipCtxRef.current ??= new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const audio = new Float32Array(v.audio);
      const buf = ctx.createBuffer(1, audio.length, v.sampleRate);
      buf.getChannelData(0).set(audio);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    } catch (e) {
      setError(`播放失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!p.card) return null;
  if (!cloning) {
    return (
      <div className="field">
        <div className="dim-sm">
          当前 TTS（{p.card.name}）不支持音色克隆。想用自己的声音，换成支持克隆的模型：
          MOSS-TTS-Nano（100M 轻量）、Qwen3-TTS（中英）、VoxCPM2（48kHz）、IndexTTS 2.5 等。
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label>
        音色来源
        <HelpTip text={`录或导入一段 ${limits.min}-${limits.max} 秒的清晰人声（单人、无背景音乐），模型会以此为参考克隆说话人。${voice?.transcriptRequired ? '该模型还要求填写这段音频的文字稿。' : ''}`} />
      </label>
      {!cloneOnly && (
        <div className="seg">
          <button className={p.source !== 'clone' ? 'on' : ''} onClick={() => p.onSource('preset')}>内置音色</button>
          <button className={p.source === 'clone' ? 'on' : ''} onClick={() => p.onSource('clone')}>克隆音色</button>
        </div>
      )}
      {cloneOnly && <div className="dim-sm">该模型没有内置音色，只能克隆（首次使用请先录/导入一段参考音频）。</div>}

      {showClone && (
        <>
          <input value={transcript} onChange={(e) => setTranscript(e.target.value)}
            placeholder={voice?.transcriptRequired ? '参考音频的文字稿（必填）：逐字写出音频里说的话' : '音频文字稿（可选，提升相似度）'}
            className="tr-input" />
          <div className="voice-btns">
            {recording ? (
              <button className="btn small rec on" onClick={() => void stopRecord(true)}>
                <Square size={12} /> 停止并保存 {elapsed.toFixed(1)}s
              </button>
            ) : (
              <button className="btn small" disabled={p.micBusy} title={p.micBusy ? '会话进行中麦克风被占用，先停止会话' : `录 ${limits.min}-${limits.max} 秒`} onClick={() => void startRecord()}>
                <Mic size={12} /> 录音
              </button>
            )}
            {recording && <button className="btn small" onClick={() => void stopRecord(false)}><Trash2 size={12} /> 取消</button>}
            <button className="btn small" disabled={p.micBusy} onClick={() => fileRef.current?.click()}><Upload size={12} /> 导入音频</button>
            <button
              className="btn small" disabled={!p.canPreview || previewing}
              title={p.canPreview ? '用当前音色合成一句试听（无需开始会话，首次会加载 TTS 模型）' : '先在上方下载所选 TTS 模型'}
              onClick={async () => {
                setPreviewing(true); setError('');
                try { await p.onPreview(); }
                catch (e) { setError(`试听失败：${e instanceof Error ? e.message : String(e)}`); }
                finally { setPreviewing(false); }
              }}>
              <Play size={12} /> {previewing ? '合成中…' : '试听'}
            </button>
            <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }} />
          </div>
          <div className="device-list">
            {voices.length === 0 && <div className="device-option disabled"><span>还没有克隆音色：录一段或导入一个音频文件</span></div>}
            {voices.map((v) => (
              <div key={v.id} className={`device-option${p.voiceId === v.id ? ' selected' : ''}`}
                onClick={() => p.onVoiceId(v.id)} role="option" aria-selected={p.voiceId === v.id}>
                {renaming === v.id ? (
                  <input autoFocus className="rename-input" value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') { await renameVoice(v.id, renameText.trim() || v.name); setRenaming(null); void refresh(); }
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={async () => { if (renameText.trim()) await renameVoice(v.id, renameText.trim()); setRenaming(null); void refresh(); }} />
                ) : (
                  <span title={v.transcript || undefined}>
                    <AudioLines size={12} className="voice-ico" /> {v.name}
                    <span className="dim-sm"> {clipSeconds(v).toFixed(1)}s{v.transcript ? ' · 有文字稿' : ''}</span>
                  </span>
                )}
                <span className="voice-acts">
                  <button title="播放原始录音" onClick={(e) => { e.stopPropagation(); void playRaw(v); }}><Play size={12} /></button>
                  <button title="重命名" onClick={(e) => { e.stopPropagation(); setRenaming(v.id); setRenameText(v.name); }}><Pencil size={12} /></button>
                  <button title="删除" onClick={async (e) => {
                    e.stopPropagation();
                    await deleteVoice(v.id);
                    if (p.voiceId === v.id) p.onVoiceId(null);
                    void refresh();
                  }}><Trash2 size={12} /></button>
                </span>
              </div>
            ))}
          </div>
          {showClone && !p.voiceId && !recording && (
            <div className="hint-warn">还没有选中克隆音色——点上面列表里的一行选中它。</div>
          )}
        </>
      )}
      {error && <div className="hint-warn">{error}</div>}
    </div>
  );
}
