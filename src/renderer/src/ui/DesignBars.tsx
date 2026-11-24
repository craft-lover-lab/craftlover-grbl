import { useEffect, useState, type ReactNode } from 'react';
import type { Anchor, Bounds, Item, Layer } from '../core/types';
import type { Tool } from './Workspace';
import type { AlignMode } from './designOps';
import type { BoolOp } from '../core/boolean';
import { refPoint } from './designOps';
import { t, type Key } from '../i18n';

// ---------- Numeric field: applies on Enter or blur (avoids one undo step per keystroke) ----------
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

// ---------- Drawing tool bar (left) ----------
const TOOLS: { id: Tool; key: string; label: Key; icon: ReactNode }[] = [
  { id: 'select', key: 'V', label: 'tool.select', icon: <path d="M5 3l13 8-6 1.5L9.5 19z" /> },
  { id: 'node', key: 'N', label: 'tool.node', icon: <path d="M4 18C8 6 16 6 20 18M2.5 16.5h3v3h-3zM18.5 16.5h3v3h-3zM10.5 7.5h3v3h-3z" /> },
  { id: 'line', key: 'L', label: 'tool.line', icon: <path d="M4 20L11 9l4 5 5-10" /> },
  { id: 'rect', key: 'R', label: 'tool.rect', icon: <rect x="4" y="6" width="16" height="12" rx="1" /> },
  { id: 'ellipse', key: 'E', label: 'tool.ellipse', icon: <ellipse cx="12" cy="12" rx="8" ry="7" /> },
  { id: 'polygon', key: 'P', label: 'tool.polygon', icon: <path d="M12 3l8 6-3 10H7L4 9z" /> },
  { id: 'text', key: 'T', label: 'tool.text', icon: <path d="M5 6V4h14v2M12 4v16M9 20h6" /> },
];

export function ToolBar({ tool, setTool, sides, setSides }: { tool: Tool; setTool: (t: Tool) => void; sides: number; setSides: (n: number) => void }) {
  return (
    <nav className="toolbox">
      {TOOLS.map((tl) => (
        <button key={tl.id} className={tool === tl.id ? 'sel' : ''} title={`${t(tl.label)} (${tl.key})`} onClick={() => setTool(tl.id)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
            {tl.icon}
          </svg>
        </button>
      ))}
      {tool === 'polygon' && (
        <label className="sides" title={t('tool.sidesTip')}>
          <input type="number" min={3} max={64} value={sides} onChange={(e) => setSides(Math.max(3, Math.min(64, Math.round(+e.target.value) || 3)))} />
          {t('tool.sides')}
        </label>
      )}
    </nav>
  );
}

// ---------- Property bar (position, size, rotation, alignment) ----------
const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

export interface PropertyActions {
  moveTo: (dx: number, dy: number) => void;
  resize: (sx: number, sy: number, fix: { x: number; y: number }) => void;
  rotate: (deg: number) => void;
  flip: (h: boolean, v: boolean) => void;
  align: (m: AlignMode, toBed: boolean) => void;
  distribute: (axis: 'x' | 'y') => void;
  boolean: (op: BoolOp) => void;
  group: () => void;
  ungroup: () => void;
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
  const vec = sel.filter((i) => i.kind === 'vector').length;
  const icon = (d: string) => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d={d} />
    </svg>
  );
  return (
    <div className="propbar">
      <div className="anchors small" title={t('prop.anchorTip')}>
        {ANCHORS.map((a) => (
          <button key={a} className={a === anchor ? 'sel' : ''} onClick={() => setAnchor(a)} />
        ))}
      </div>
      <label>X</label>
      <NumField value={ref.x} disabled={none} onCommit={(v) => act.moveTo(v - ref.x, 0)} />
      <label>Y</label>
      <NumField value={ref.y} disabled={none} onCommit={(v) => act.moveTo(0, v - ref.y)} />
      <label>{t('prop.width')}</label>
      <NumField value={w} min={0.01} disabled={none} onCommit={(v) => act.resize(v / w, lock ? v / w : 1, ref)} />
      <button className={`lock ${lock ? 'sel' : ''}`} title={t('prop.lockTip')} onClick={() => setLock(!lock)}>
        {lock ? '🔒' : '🔓'}
      </button>
      <label>{t('prop.height')}</label>
      <NumField value={h} min={0.01} disabled={none} onCommit={(v) => act.resize(lock ? v / h : 1, v / h, ref)} />
      <span className="sep" />
      <button disabled={none} title={t('prop.rotCCW')} onClick={() => act.rotate(90)}>⟲</button>
      <button disabled={none} title={t('prop.rotCW')} onClick={() => act.rotate(-90)}>⟳</button>
      <NumField value={angle} step={1} onCommit={setAngle} title={t('prop.angleTip')} />
      <button disabled={none} onClick={() => act.rotate(angle)} title={t('prop.rotateTip')}>{t('prop.rotate')}</button>
      <button disabled={none} title={t('prop.flipH')} onClick={() => act.flip(true, false)}>⇋</button>
      <button disabled={none} title={t('prop.flipV')} onClick={() => act.flip(false, true)}>⇵</button>
      <span className="sep" />
      <button disabled={none} title={t(multi ? 'align.left' : 'align.leftBed')} onClick={() => act.align('left', !multi)}>{icon('M4 3v18M8 7h10v4H8zM8 14h6v4H8z')}</button>
      <button disabled={none} title={t(multi ? 'align.hcenter' : 'align.hcenterBed')} onClick={() => act.align('hcenter', !multi)}>{icon('M12 3v18M6 7h12v4H6zM8 14h8v4H8z')}</button>
      <button disabled={none} title={t(multi ? 'align.right' : 'align.rightBed')} onClick={() => act.align('right', !multi)}>{icon('M20 3v18M6 7h10v4H6zM10 14h6v4h-6z')}</button>
      <button disabled={none} title={t(multi ? 'align.top' : 'align.topBed')} onClick={() => act.align('top', !multi)}>{icon('M3 4h18M7 8h4v10H7zM14 8h4v6h-4z')}</button>
      <button disabled={none} title={t(multi ? 'align.vcenter' : 'align.vcenterBed')} onClick={() => act.align('vcenter', !multi)}>{icon('M3 12h18M7 6h4v12H7zM14 8h4v8h-4z')}</button>
      <button disabled={none} title={t(multi ? 'align.bottom' : 'align.bottomBed')} onClick={() => act.align('bottom', !multi)}>{icon('M3 20h18M7 6h4v10H7zM14 10h4v6h-4z')}</button>
      <button disabled={sel.length < 3} title={t('dist.x')} onClick={() => act.distribute('x')}>{icon('M4 4v16M20 4v16M9 8h6v8H9z')}</button>
      <button disabled={sel.length < 3} title={t('dist.y')} onClick={() => act.distribute('y')}>{icon('M4 4h16M4 20h16M8 9h8v6H8z')}</button>
      <span className="sep" />
      <button disabled={vec < 2} title={t('group.groupTip')} onClick={act.group}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M3 7V3" /><rect x="6" y="6" width="7" height="7" /><rect x="11" y="11" width="7" height="7" /></svg>
      </button>
      <button disabled={vec < 1} title={t('group.ungroupTip')} onClick={act.ungroup}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><path d="M13 6h3M18 8v3M6 13v3M8 18h3" strokeDasharray="1.5 1.5" /></svg>
      </button>
      <span className="sep" />
      <button disabled={vec < 2} title={t('bool.unionTip')} onClick={() => act.boolean('union')}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" fillOpacity=".35" stroke="currentColor" strokeWidth="1.6"><path d="M3 4h11v5h7v11H10v-5H3z" /></svg>
      </button>
      <button disabled={vec < 2} title={t('bool.subtractTip')} onClick={() => act.boolean('subtract')}>
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="1.6"><path d="M3 4h11v5h-4v6H3z" fill="currentColor" fillOpacity=".35" /><path d="M10 9h11v11H10z" fill="none" strokeDasharray="2 2" /></svg>
      </button>
      <button disabled={vec < 2} title={t('bool.intersectTip')} onClick={() => act.boolean('intersect')}>
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="1.6"><path d="M3 4h11v11H3zM10 9h11v11H10z" fill="none" strokeDasharray="2 2" /><path d="M10 9h4v6h-4z" fill="currentColor" fillOpacity=".5" /></svg>
      </button>
      <span className="muted">{sel.length ? t('prop.count', { n: sel.length }) : t('prop.none')}</span>
    </div>
  );
}

// ---------- Color palette (bottom): each color is a layer ----------
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
            title={l ? t('palette.usedTip', { name: l.name }) : t('palette.newTip')}
            onClick={() => onPick(c)}
          >
            {String(i).padStart(2, '0')}
          </button>
        );
      })}
      <span className="muted">{t('palette.help')}</span>
    </div>
  );
}
