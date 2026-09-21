// Sokuji-style device list + help tooltip (AGPL-3.0 design port from
// src/components/Settings/shared/DeviceList.tsx + its option-row dialect).
// Simplified for LocalTalk: no mute-toggle, first row is 系统默认 instead of
// 关闭; loopback-looking inputs get a warning icon but stay selectable.

import { AlertTriangle } from 'lucide-react';

// OS "what-u-hear" style inputs re-capture whatever the machine plays —
// our own TTS included. Sokuji warns the same way (selectable, not blocked).
const LOOPBACK_RE = /stereo mix|what u hear|what you hear|loopback|vb-?cable|cable (input|output)|i\/o hello|voicemeeter|sokuji/i;

export interface DeviceListProps {
  devices: MediaDeviceInfo[];
  /** '' = system default (the first row). */
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  kind?: 'input' | 'output';
}

export default function DeviceList({ devices, selectedId, onSelect, disabled = false, kind = 'input' }: DeviceListProps) {
  const rowCls = (sel: boolean) => `device-option${sel ? ' selected' : ''}${disabled ? ' disabled' : ''}`;
  const pick = (id: string) => { if (!disabled) onSelect(id); };
  return (
    <div className="device-list" role="listbox" aria-disabled={disabled || undefined}>
      <div className={rowCls(selectedId === '')} onClick={() => pick('')} role="option" aria-selected={selectedId === ''} tabIndex={disabled ? -1 : 0}>
        <span>系统默认</span>
      </div>
      {devices.map((d) => {
        const suspect = kind === 'input' && LOOPBACK_RE.test(d.label);
        return (
          <div
            key={d.deviceId}
            className={rowCls(selectedId === d.deviceId)}
            onClick={() => pick(d.deviceId)}
            role="option"
            aria-selected={selectedId === d.deviceId}
            tabIndex={disabled ? -1 : 0}
          >
            <span title={d.label || undefined}>{d.label || `设备 ${d.deviceId.slice(0, 6)}`}</span>
            {suspect && (
              <span className="virtual-indicator" title="这像是环回/虚拟设备：会拾取本机播放的声音（含译文朗读），可能造成回声">
                <AlertTriangle size={14} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Small "?" badge with a hover bubble — Sokuji's Tooltip icon="help" dialect. */
export function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip" tabIndex={0}>
      ?
      <span className="help-bubble">{text}</span>
    </span>
  );
}
