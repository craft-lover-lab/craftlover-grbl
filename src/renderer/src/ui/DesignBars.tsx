import { useEffect, useState, type ReactNode } from 'react';
import type { Anchor, Bounds, Item, Layer } from '../core/types';
import type { Tool } from './Workspace';
import type { AlignMode } from './designOps';
import { refPoint } from './designOps';

// ---------- Ô nhập số: chỉ áp dụng khi Enter hoặc rời ô (tránh ghi lịch sử từng phím) ----------
export function NumField({ value, onCommit, step = 0.1, min, title, disabled }: { value: number; onCommit: (v: number) => void; step?: number; min?: number; title?: string; disabled?: boolean }) {
  const fmt = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '');
  const [text, setText] = useState(fmt(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmt(value));
  }, [value, focus]);
  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (Number.isFinite(v) && (min === undefined || v >= min) && Math.abs(v - value) > 1e-9) onCommit(v);
    else setText(fmt(value));
  };
  return (
    <input
      className="num"
      type="number"
      step={step}
      title={title}
      disabled={disabled}
      value={text}
      onFocus={() => setFocus(true)}
      onBlur={() => {
        setFocus(false);
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).select();
        }
        if (e.key === 'Escape') setText(fmt(value));
      }}
    />
  );
}

// ---------- Thanh công cụ vẽ (bên trái) ----------
const TOOLS: { id: Tool; key: string; label: string; icon: ReactNode }[] = [
  { id: 'select', key: 'V', label: 'Chọn', icon: <path d="M5 3l13 8-6 1.5L9.5 19z" /> },
  { id: 'line', key: 'L', label: 'Vẽ đường (bút)', icon: <path d="M4 20L11 9l4 5 5-10" /> },
  { id: 'rect', key: 'R', label: 'Hình chữ nhật', icon: <rect x="4" y="6" width="16" height="12" rx="1" /> },
  { id: 'ellipse', key: 'E', label: 'Elip / hình tròn', icon: <ellipse cx="12" cy="12" rx="8" ry="7" /> },
  { id: 'polygon', key: 'P', label: 'Đa giác đều', icon: <path d="M12 3l8 6-3 10H7L4 9z" /> },
  { id: 'text', key: 'T', label: 'Chữ', icon: <path d="M5 6V4h14v2M12 4v16M9 20h6" /> },
];

export function ToolBar({ tool, setTool, sides, setSides }: { tool: Tool; setTool: (t: Tool) => void; sides: number; setSides: (n: number) => void }) {
  return (
    <nav className="toolbox">
      {TOOLS.map((t) => (
        <button key={t.id} className={tool === t.id ? 'sel' : ''} title={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
            {t.icon}
          </svg>
        </button>
      ))}
      {tool === 'polygon' && (
        <label className="sides" title="Số cạnh">
          <input type="number" min={3} max={64} value={sides} onChange={(e) => setSides(Math.max(3, Math.min(64, Math.round(+e.target.value) || 3)))} />
          cạnh
        </label>
      )}
    </nav>
  );
}

// ---------- Thanh thuộc tính (vị trí, kích thước, xoay, căn chỉnh) ----------
const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

export interface PropertyActions {
  moveTo: (dx: number, dy: number) => void;
  resize: (sx: number, sy: number, fix: { x: number; y: number }) => void;
  rotate: (deg: number) => void;
  flip: (h: boolean, v: boolean) => void;
  align: (m: AlignMode, toBed: boolean) => void;
  distribute: (axis: 'x' | 'y') => void;
}

export function PropertyBar({ sel, b, act }: { sel: Item[]; b: Bounds | null; act: PropertyActions }) {
  const [anchor, setAnchor] = useState<Anchor>('bl');
  const [lock, setLock] = useState(true);
  const [angle, setAngle] = useState(90);
  const none = !b || sel.length === 0;
  const ref = b ? refPoint(b, anchor) : { x: 0, y: 0 };
  const w = b ? b.maxX - b.minX : 0;
  const h = b ? b.maxY - b.minY : 0;
  const multi = sel.length > 1;
  const icon = (d: string) => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d={d} />
    </svg>
  );
  return (
    <div className="propbar">
      <div className="anchors small" title="Điểm tham chiếu cho X/Y và khi đổi kích thước">
        {ANCHORS.map((a) => (
          <button key={a} className={a === anchor ? 'sel' : ''} onClick={() => setAnchor(a)} />
        ))}
      </div>
      <label>X</label>
      <NumField value={ref.x} disabled={none} onCommit={(v) => act.moveTo(v - ref.x, 0)} />
      <label>Y</label>
      <NumField value={ref.y} disabled={none} onCommit={(v) => act.moveTo(0, v - ref.y)} />
      <label>Rộng</label>
      <NumField value={w} min={0.01} disabled={none} onCommit={(v) => act.resize(v / w, lock ? v / w : 1, ref)} />
      <button className={`lock ${lock ? 'sel' : ''}`} title="Giữ tỉ lệ" onClick={() => setLock(!lock)}>
        {lock ? '🔒' : '🔓'}
      </button>
      <label>Cao</label>
      <NumField value={h} min={0.01} disabled={none} onCommit={(v) => act.resize(lock ? v / h : 1, v / h, ref)} />
      <span className="sep" />
      <button disabled={none} title="Xoay 90° ngược chiều kim đồng hồ" onClick={() => act.rotate(90)}>⟲</button>
      <button disabled={none} title="Xoay 90° theo chiều kim đồng hồ" onClick={() => act.rotate(-90)}>⟳</button>
      <NumField value={angle} step={1} onCommit={setAngle} title="Góc xoay (°)" />
      <button disabled={none} onClick={() => act.rotate(angle)} title="Xoay theo góc đã nhập">Xoay</button>
      <button disabled={none} title="Lật ngang" onClick={() => act.flip(true, false)}>⇋</button>
      <button disabled={none} title="Lật dọc" onClick={() => act.flip(false, true)}>⇵</button>
      <span className="sep" />
      <button disabled={none} title={multi ? 'Căn trái' : 'Sát mép trái bàn máy'} onClick={() => act.align('left', !multi)}>{icon('M4 3v18M8 7h10v4H8zM8 14h6v4H8z')}</button>
      <button disabled={none} title={multi ? 'Căn giữa theo chiều ngang' : 'Giữa bàn theo chiều ngang'} onClick={() => act.align('hcenter', !multi)}>{icon('M12 3v18M6 7h12v4H6zM8 14h8v4H8z')}</button>
      <button disabled={none} title={multi ? 'Căn phải' : 'Sát mép phải bàn máy'} onClick={() => act.align('right', !multi)}>{icon('M20 3v18M6 7h10v4H6zM10 14h6v4h-6z')}</button>
      <button disabled={none} title={multi ? 'Căn trên' : 'Sát mép trên bàn máy'} onClick={() => act.align('top', !multi)}>{icon('M3 4h18M7 8h4v10H7zM14 8h4v6h-4z')}</button>
      <button disabled={none} title={multi ? 'Căn giữa theo chiều dọc' : 'Giữa bàn theo chiều dọc'} onClick={() => act.align('vcenter', !multi)}>{icon('M3 12h18M7 6h4v12H7zM14 8h4v8h-4z')}</button>
      <button disabled={none} title={multi ? 'Căn dưới' : 'Sát mép dưới bàn máy'} onClick={() => act.align('bottom', !multi)}>{icon('M3 20h18M7 6h4v10H7zM14 10h4v6h-4z')}</button>
      <button disabled={sel.length < 3} title="Chia đều theo chiều ngang" onClick={() => act.distribute('x')}>{icon('M4 4v16M20 4v16M9 8h6v8H9z')}</button>
      <button disabled={sel.length < 3} title="Chia đều theo chiều dọc" onClick={() => act.distribute('y')}>{icon('M4 4h16M4 20h16M8 9h8v6H8z')}</button>
      <span className="muted">{sel.length ? `${sel.length} đối tượng` : 'Chưa chọn'}</span>
    </div>
  );
}

// ---------- Bảng màu (bên dưới): mỗi màu là một lớp gia công ----------
export const PALETTE = [
  '#e5243b', '#2f7cf6', '#18a058', '#333333', '#f08a24', '#a239ca', '#00a8a8', '#c7b200', '#e05297', '#7a5230',
  '#1b3a8a', '#7fb800', '#ff5c39', '#5f6b7a', '#00b3e6', '#9e0059', '#2e7d32', '#ffb000', '#6a4cff', '#b33f00',
];

export function Palette({ layers, activeId, onPick }: { layers: Layer[]; activeId: string; onPick: (color: string) => void }) {
  return (
    <div className="palette">
      {PALETTE.map((c, i) => {
        const l = layers.find((x) => x.color.toLowerCase() === c);
        return (
          <button
            key={c}
            className={`swatch-btn ${l && l.id === activeId ? 'active' : ''} ${l ? 'used' : ''}`}
            style={{ background: c }}
            title={l ? `${l.name} — nhấp để gán đối tượng đang chọn vào lớp này` : 'Lớp mới — nhấp để gán đối tượng đang chọn'}
            onClick={() => onPick(c)}
          >
            {String(i).padStart(2, '0')}
          </button>
        );
      })}
      <span className="muted">Chọn đối tượng rồi nhấp một màu để đổi lớp · Không chọn gì: đặt màu cho hình vẽ mới</span>
    </div>
  );
}
