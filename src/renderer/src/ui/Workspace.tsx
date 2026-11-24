import { useEffect, useRef, useState } from 'react';
import type { Bounds, Item, Layer, Polyline, Pt } from '../core/types';
import { copyOffsets, isEmpty, itemBounds, placedPaths, pathsBounds } from '../core/geometry';
import { regularPolygonBox, shapePaths } from '../core/shapes';
import { hitItem, itemTouchesRect, moveItems, rotateItems, scaleItems, selBounds } from './designOps';
import { deleteNode, hitNode, hitSegment, insertNode, itemWithPaths, moveNode, nodeCount, worldPaths, type NodeRef } from '../core/nodes';
import { t, type Key } from '../i18n';

export type Tool = 'select' | 'node' | 'line' | 'rect' | 'ellipse' | 'polygon' | 'text';

export type NewItem = Omit<Item, 'id' | 'copies'>;

interface Props {
  bedW: number;
  bedH: number;
  items: Item[];
  layers: Layer[];
  selectedIds: string[];
  tool: Tool;
  polygonSides: number;
  activeLayer: Layer | undefined;
  onSelect: (ids: string[]) => void;
  /** Record an undo step before a drag starts */
  onBeginEdit: () => void;
  /** Live update while dragging (no history) */
  onLive: (fn: (items: Item[]) => Item[]) => void;
  /** Single-step change (recorded in history) */
  onCommit: (fn: (items: Item[]) => Item[]) => void;
  onCreate: (it: NewItem) => void;
  onTextAt: (p: Pt) => void;
  onToolDone: () => void;
  /** Double-click on an object with the select tool (edit text / nodes) */
  onEditItem: (it: Item) => void;
  laserPos: Pt | null;
  jobFrame: Bounds | null;
  preview: { cut: Polyline[]; travel: Polyline[] } | null;
}

const imgCache = new Map<string, HTMLImageElement>();
function getImg(url: string, redraw: () => void) {
  let im = imgCache.get(url);
  if (!im) {
    im = new Image();
    im.onload = redraw;
    im.src = url;
    imgCache.set(url, im);
  }
  return im;
}

type Handle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';
const HANDLES: Handle[] = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];

type Drag =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'move'; base: Item[]; ids: Set<string>; start: Pt; moved: boolean }
  | { kind: 'scale'; base: Item[]; ids: Set<string>; b: Bounds; h: Handle }
  | { kind: 'rotate'; ids: Set<string>; c: Pt; a0: number }
  | { kind: 'marquee'; start: Pt; additive: boolean }
  | { kind: 'draw'; start: Pt }
  | { kind: 'node'; base: Item; wp: Polyline[]; ref: NodeRef; start: Pt; moved: boolean };

interface Overlay {
  marquee?: { a: Pt; b: Pt };
  ghost?: Polyline[];
  rotate?: { c: Pt; angle: number; b: Bounds };
}

const snap = (v: number, on: boolean) => (on ? Math.round(v * 2) / 2 : v);

function handlePos(b: Bounds, h: Handle): Pt {
  const x = h.includes('l') ? b.minX : h.includes('r') ? b.maxX : (b.minX + b.maxX) / 2;
  const y = h.startsWith('t') ? b.maxY : h.startsWith('b') ? b.minY : (b.minY + b.maxY) / 2;
  return { x, y };
}

export function Workspace(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ scale: 1.5, ox: 40, oy: 40 }); // ox/oy: screen position of the (0,0) origin, measured from the bottom-left
  const drag = useRef<Drag | null>(null);
  const [tick, setTick] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>({});
  const [pen, setPen] = useState<Pt[]>([]);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [space, setSpace] = useState(false);
  const userMoved = useRef(false);

  const selSet = new Set(p.selectedIds);
  const selItems = p.items.filter((i) => selSet.has(i.id));
  const sb = selItems.length ? selBounds(selItems) : null;
  // Node editing: the one selected vector object and its selected node
  const nodeItem = p.tool === 'node' && selItems.length === 1 && selItems[0].kind === 'vector' ? selItems[0] : null;
  const [node, setNode] = useState<NodeRef | null>(null);
  useEffect(() => setNode(null), [p.tool, nodeItem?.id]);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(100, r.width), h: Math.max(100, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (userMoved.current || size.w < 200) return;
    const s = Math.min((size.w - 60) / p.bedW, (size.h - 60) / p.bedH);
    setView({ scale: s, ox: (size.w - p.bedW * s) / 2, oy: (size.h - p.bedH * s) / 2 });
  }, [size, p.bedW, p.bedH]);

  // Switching tools cancels an unfinished pen path
  useEffect(() => setPen([]), [p.tool]);

  const toS = (x: number, y: number) => [view.ox + x * view.scale, size.h - (view.oy + y * view.scale)] as const;
  const toMM = (sx: number, sy: number): Pt => ({ x: (sx - view.ox) / view.scale, y: (size.h - sy - view.oy) / view.scale });

  // ---------- Pen (polyline) tool ----------
  const finishPen = (close: boolean) => {
    const pts = close && pen.length > 2 ? [...pen, { ...pen[0] }] : pen;
    setPen([]);
    if (pts.length < 2) return;
    const b = pathsBounds([pts]);
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    p.onCreate({
      name: t(close ? 'shape.closed' : 'shape.line'),
      kind: 'vector',
      shape: { type: 'line' },
      paths: [pts.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY }))],
      srcW: w,
      srcH: h,
      w,
      h,
      x: b.minX,
      y: b.minY,
      layerId: p.activeLayer?.id ?? 'cut',
    });
    p.onToolDone();
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space' && !space) setSpace(true);
      if (nodeItem && node && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        const it = nodeItem;
        const rest = deleteNode(worldPaths(it), node);
        setNode(null);
        // Deleting the last node of the last path removes the object
        p.onCommit((items) => (rest.length ? items.map((i) => (i.id === it.id ? itemWithPaths(i, rest) : i)) : items.filter((i) => i.id !== it.id)));
      }
      if (p.tool === 'line' && pen.length) {
        if (e.key === 'Enter') finishPen(false);
        else if (e.key === 'Escape') setPen([]);
        else if (e.key === 'Backspace') setPen((a) => a.slice(0, -1));
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  // ---------- Rendering ----------
  useEffect(() => {
    const c = cv.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#15171b';
    ctx.fillRect(0, 0, size.w, size.h);

    const line = (pl: Pt[]) =>
      pl.forEach((q, i) => {
        const [x, y] = toS(q.x, q.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });

    // Bed and grid (1 mm grid when zoomed in far enough)
    const [bx0, by0] = toS(0, 0);
    const [bx1, by1] = toS(p.bedW, p.bedH);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(bx0, by1, bx1 - bx0, by0 - by1);
    ctx.lineWidth = 1;
    const fine = view.scale > 6 ? 1 : 10;
    for (let g = 0; g <= Math.max(p.bedW, p.bedH); g += fine) {
      ctx.strokeStyle = g % 50 === 0 ? '#cfc9bd' : g % 10 === 0 ? '#e0dacd' : '#ece8de';
      if (g <= p.bedW) {
        const [x] = toS(g, 0);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, by0);
        ctx.lineTo(Math.round(x) + 0.5, by1);
        ctx.stroke();
      }
      if (g <= p.bedH) {
        const [, y] = toS(0, g);
        ctx.beginPath();
        ctx.moveTo(bx0, Math.round(y) + 0.5);
        ctx.lineTo(bx1, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#8b93a1';
    ctx.font = '11px system-ui';
    const lab = view.scale > 3 ? 10 : 50;
    for (let g = 0; g <= p.bedW; g += lab) {
      const [x] = toS(g, 0);
      ctx.fillText(String(g), x + 2, by0 + 13);
    }
    for (let g = lab; g <= p.bedH; g += lab) {
      const [, y] = toS(0, g);
      ctx.fillText(String(g), bx0 - 26, y + 4);
    }

    // Objects
    const layerOf = (id: string) => p.layers.find((l) => l.id === id);
    for (const it of p.items) {
      const layer = layerOf(it.layerId);
      const color = layer?.color ?? '#000';
      ctx.globalAlpha = layer && !layer.enabled ? 0.25 : 1;
      for (const o of copyOffsets(it)) {
        if (it.kind === 'bitmap' && it.bitmap) {
          const im = getImg(it.bitmap.url, () => setTick((t) => t + 1));
          const [x, y] = toS(o.x, o.y + it.h);
          if (im.complete) ctx.drawImage(im, x, y, it.w * view.scale, it.h * view.scale);
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          placedPaths(it, o).forEach(line);
          if (layer?.mode === 'fill') {
            ctx.fillStyle = color + '55';
            ctx.fill('evenodd');
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Toolpath preview
    if (p.preview) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(80,110,160,.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      p.preview.travel.forEach(line);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(220,40,40,.45)';
      ctx.beginPath();
      p.preview.cut.forEach(line);
      ctx.stroke();
    }

    // Selected objects: blue dashed overlay
    if (selItems.length) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#1a5fd6';
      ctx.lineWidth = 1.5;
      for (const it of selItems) {
        ctx.beginPath();
        if (it.kind === 'bitmap') {
          const [x0, y0] = toS(it.x, it.y + it.h);
          ctx.rect(x0, y0, it.w * view.scale, it.h * view.scale);
        } else placedPaths(it, it).forEach(line);
        ctx.stroke();
        // Outline of the grid copies
        if (it.copies.cols * it.copies.rows > 1) {
          const b = itemBounds(it);
          const [x0, y0] = toS(b.minX, b.maxY);
          const [x1, y1] = toS(b.maxX, b.minY);
          ctx.strokeStyle = 'rgba(26,95,214,.35)';
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          ctx.strokeStyle = '#1a5fd6';
        }
      }
      ctx.setLineDash([]);
    }

    // Node editing: every vertex of the object, the selected one filled
    if (nodeItem) {
      worldPaths(nodeItem).forEach((pl, pi) => {
        const n = nodeCount(pl);
        for (let ni = 0; ni < n; ni++) {
          const [x, y] = toS(pl[ni].x, pl[ni].y);
          const sel = node && node.pi === pi && node.ni === ni;
          ctx.fillStyle = sel ? '#1a5fd6' : '#fff';
          ctx.strokeStyle = '#1a5fd6';
          ctx.lineWidth = 1;
          ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
          ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
        }
      });
    }

    // Selection box + handles
    if (sb && !overlay.rotate && p.tool !== 'node') {
      const [x0, y0] = toS(sb.minX, sb.maxY);
      const [x1, y1] = toS(sb.maxX, sb.minY);
      ctx.strokeStyle = '#2f7cf6';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      for (const h of HANDLES) {
        const q = handlePos(sb, h);
        const [hx, hy] = toS(q.x, q.y);
        ctx.fillRect(hx - 4, hy - 4, 8, 8);
        ctx.strokeRect(hx - 4, hy - 4, 8, 8);
      }
      // Rotation handle on top
      const [rx, ry] = toS((sb.minX + sb.maxX) / 2, sb.maxY);
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx, ry - 22);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rx, ry - 26, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2f7cf6';
      ctx.fillText(`${(sb.maxX - sb.minX).toFixed(1)} × ${(sb.maxY - sb.minY).toFixed(1)} mm`, x0, y1 + 14);
    }

    // While rotating: draw the rotated box
    if (overlay.rotate) {
      const { c, angle, b } = overlay.rotate;
      const t = (angle * Math.PI) / 180;
      const corners = [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
        { x: b.minX, y: b.minY },
      ].map((q) => ({ x: c.x + (q.x - c.x) * Math.cos(t) - (q.y - c.y) * Math.sin(t), y: c.y + (q.x - c.x) * Math.sin(t) + (q.y - c.y) * Math.cos(t) }));
      ctx.strokeStyle = '#2f7cf6';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      line(corners);
      ctx.stroke();
      ctx.setLineDash([]);
      const [cx, cy] = toS(c.x, c.y);
      ctx.fillStyle = '#2f7cf6';
      ctx.fillText(`${angle.toFixed(1)}°`, cx + 8, cy - 8);
    }

    // Marquee: left→right = window select, right→left = crossing select
    if (overlay.marquee) {
      const { a, b } = overlay.marquee;
      const [x0, y0] = toS(a.x, a.y);
      const [x1, y1] = toS(b.x, b.y);
      const crossing = b.x < a.x;
      ctx.fillStyle = crossing ? 'rgba(24,160,88,.08)' : 'rgba(47,124,246,.08)';
      ctx.strokeStyle = crossing ? '#18a058' : '#2f7cf6';
      ctx.setLineDash(crossing ? [5, 4] : []);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }

    // Shape being drawn / pen path
    const ghostColor = p.activeLayer?.color ?? '#e5243b';
    if (overlay.ghost) {
      ctx.strokeStyle = ghostColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      overlay.ghost.forEach(line);
      ctx.stroke();
    }
    if (pen.length) {
      ctx.strokeStyle = ghostColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      line(cursor ? [...pen, cursor] : pen);
      ctx.stroke();
      ctx.fillStyle = ghostColor;
      for (const q of pen) {
        const [x, y] = toS(q.x, q.y);
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
    }

    // Job outline (when running from the current position)
    if (p.jobFrame && !isEmpty(p.jobFrame)) {
      const b = p.jobFrame;
      const [x0, y0] = toS(b.minX, b.maxY);
      const [x1, y1] = toS(b.maxX, b.minY);
      ctx.setLineDash([8, 4]);
      ctx.strokeStyle = '#f08a24';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }

    // Work origin and laser head position
    const [zx, zy] = toS(0, 0);
    ctx.strokeStyle = '#18a058';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(zx, zy);
    ctx.lineTo(zx + 24, zy);
    ctx.moveTo(zx, zy);
    ctx.lineTo(zx, zy - 24);
    ctx.stroke();
    if (p.laserPos) {
      const [lx, ly] = toS(p.laserPos.x, p.laserPos.y);
      ctx.strokeStyle = '#e5243b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(lx, ly, 7, 0, Math.PI * 2);
      ctx.moveTo(lx - 12, ly);
      ctx.lineTo(lx + 12, ly);
      ctx.moveTo(lx, ly - 12);
      ctx.lineTo(lx, ly + 12);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.items, p.layers, p.selectedIds, p.preview, p.jobFrame, p.laserPos, p.bedW, p.bedH, view, size, tick, overlay, pen, cursor && p.tool === 'line' ? cursor : null, p.tool, node]);

  // ---------- Mouse ----------
  const local = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const tolMM = () => 5 / view.scale;

  const topHit = (m: Pt) => {
    for (let i = p.items.length - 1; i >= 0; i--) {
      const it = p.items[i];
      const filled = p.layers.find((l) => l.id === it.layerId)?.mode === 'fill';
      if (hitItem(it, m, tolMM(), filled)) return it;
    }
    return null;
  };

  /** Drawing point: snaps to a 0.5 mm grid (hold Alt to disable); Shift locks 15° steps from the previous point. */
  const drawPt = (m: Pt, e: React.MouseEvent, prev?: Pt): Pt => {
    if (prev && e.shiftKey) {
      const d = Math.hypot(m.x - prev.x, m.y - prev.y);
      const a = Math.round(Math.atan2(m.y - prev.y, m.x - prev.x) / (Math.PI / 12)) * (Math.PI / 12);
      return { x: prev.x + d * Math.cos(a), y: prev.y + d * Math.sin(a) };
    }
    return { x: snap(m.x, !e.altKey), y: snap(m.y, !e.altKey) };
  };

  const shapeBox = (a: Pt, b: Pt, square: boolean, fromCenter: boolean) => {
    if (p.tool === 'polygon') {
      // Regular polygon: centered on the start point, radius to the cursor
      const pb = regularPolygonBox(p.polygonSides, Math.hypot(b.x - a.x, b.y - a.y));
      return { x: a.x - pb.cx, y: a.y - pb.cy, w: pb.w, h: pb.h };
    }
    let w = Math.abs(b.x - a.x);
    let h = Math.abs(b.y - a.y);
    if (square) w = h = Math.max(w, h);
    if (fromCenter) return { x: a.x - w, y: a.y - h, w: 2 * w, h: 2 * h };
    return { x: b.x < a.x ? a.x - w : a.x, y: b.y < a.y ? a.y - h : a.y, w, h };
  };

  const onDown = (e: React.MouseEvent) => {
    const { sx, sy } = local(e);
    const m = toMM(sx, sy);
    if (e.button === 1 || e.button === 2 || space) {
      drag.current = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy };
      return;
    }
    if (e.button !== 0) return;

    if (p.tool === 'text') {
      p.onTextAt(drawPt(m, e));
      return;
    }
    if (p.tool === 'node') {
      if (nodeItem) {
        const wp = worldPaths(nodeItem);
        const tol = 6 / view.scale;
        const hitN = hitNode(wp, m, tol);
        if (hitN) {
          setNode(hitN);
          drag.current = { kind: 'node', base: nodeItem, wp, ref: hitN, start: m, moved: false };
          return;
        }
        // Double-click on a segment adds a node there
        const seg = e.detail >= 2 ? hitSegment(wp, m, tol) : null;
        if (seg) {
          const r = insertNode(wp, seg.pi, seg.seg, seg.p);
          const it = nodeItem;
          p.onCommit((items) => items.map((i) => (i.id === it.id ? itemWithPaths(i, r.paths) : i)));
          setNode(r.node);
          return;
        }
      }
      const hit = topHit(m);
      if (hit && hit.kind === 'vector') {
        if (hit.id !== nodeItem?.id) p.onSelect([hit.id]);
      } else if (!hit) {
        setNode(null);
        if (!nodeItem) p.onSelect([]);
      }
      return;
    }
    if (p.tool === 'line') {
      const q = drawPt(m, e, pen[pen.length - 1]);
      if (pen.length > 2) {
        const [fx, fy] = toS(pen[0].x, pen[0].y);
        if (Math.hypot(sx - fx, sy - fy) < 8) return finishPen(true);
      }
      if (e.detail >= 2) return finishPen(false); // double-click finishes
      setPen((a) => [...a, q]);
      return;
    }
    if (p.tool !== 'select') {
      drag.current = { kind: 'draw', start: drawPt(m, e) };
      return;
    }

    // Selection box handles
    if (sb) {
      const [rx, ry] = toS((sb.minX + sb.maxX) / 2, sb.maxY);
      if (Math.hypot(sx - rx, sy - (ry - 26)) < 8) {
        p.onBeginEdit();
        const c = { x: (sb.minX + sb.maxX) / 2, y: (sb.minY + sb.maxY) / 2 };
        drag.current = { kind: 'rotate', ids: selSet, c, a0: Math.atan2(m.y - c.y, m.x - c.x) };
        setOverlay({ rotate: { c, angle: 0, b: sb } });
        return;
      }
      for (const h of HANDLES) {
        const q = handlePos(sb, h);
        const [hx, hy] = toS(q.x, q.y);
        if (Math.abs(sx - hx) < 7 && Math.abs(sy - hy) < 7) {
          p.onBeginEdit();
          drag.current = { kind: 'scale', base: p.items, ids: selSet, b: sb, h };
          return;
        }
      }
    }

    const hit = topHit(m);
    if (hit && e.detail >= 2 && !e.shiftKey && !e.ctrlKey) {
      p.onSelect([hit.id]);
      p.onEditItem(hit);
      return;
    }
    if (hit) {
      if (e.shiftKey || e.ctrlKey) {
        // Shift/Ctrl + click: add to / remove from the selection
        p.onSelect(selSet.has(hit.id) ? p.selectedIds.filter((i) => i !== hit.id) : [...p.selectedIds, hit.id]);
        return;
      }
      const ids = selSet.has(hit.id) ? selSet : new Set([hit.id]);
      if (!selSet.has(hit.id)) p.onSelect([hit.id]);
      drag.current = { kind: 'move', base: p.items, ids, start: m, moved: false };
      return;
    }
    if (sb && m.x >= sb.minX && m.x <= sb.maxX && m.y >= sb.minY && m.y <= sb.maxY && !e.shiftKey) {
      drag.current = { kind: 'move', base: p.items, ids: selSet, start: m, moved: false };
      return;
    }
    drag.current = { kind: 'marquee', start: m, additive: e.shiftKey || e.ctrlKey };
  };

  const onMove = (e: React.MouseEvent) => {
    const { sx, sy } = local(e);
    const m = toMM(sx, sy);
    setCursor(p.tool === 'line' && pen.length ? drawPt(m, e, pen[pen.length - 1]) : m);
    const d = drag.current;
    if (!d) return;
    switch (d.kind) {
      case 'pan':
        userMoved.current = true;
        setView((v) => ({ ...v, ox: d.ox + (sx - d.sx), oy: d.oy - (sy - d.sy) }));
        break;
      case 'move': {
        const dx = snap(m.x - d.start.x, !e.altKey);
        const dy = snap(m.y - d.start.y, !e.altKey);
        if (!d.moved && Math.hypot(dx, dy) * view.scale < 3) return;
        if (!d.moved) {
          d.moved = true;
          p.onBeginEdit();
        }
        // Shift: constrain to one axis
        const [mx, my] = e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? [dx, 0] : [0, dy]) : [dx, dy];
        p.onLive(() => moveItems(d.base, d.ids, mx, my));
        break;
      }
      case 'scale': {
        const { b, h } = d;
        const opp = handlePos(b, ({ tl: 'br', t: 'b', tr: 'bl', r: 'l', br: 'tl', b: 't', bl: 'tr', l: 'r' } as const)[h]);
        const w0 = b.maxX - b.minX || 1;
        const h0 = b.maxY - b.minY || 1;
        let sxk = h === 't' || h === 'b' ? 1 : Math.abs(m.x - opp.x) / w0;
        let syk = h === 'l' || h === 'r' ? 1 : Math.abs(m.y - opp.y) / h0;
        // Corners keep the aspect ratio (Shift stretches freely)
        if (h.length === 2 && !e.shiftKey) sxk = syk = Math.max(sxk, syk);
        sxk = Math.max(0.01, sxk);
        syk = Math.max(0.01, syk);
        p.onLive(() => scaleItems(d.base, d.ids, opp, sxk, syk));
        break;
      }
      case 'rotate': {
        let ang = ((Math.atan2(m.y - d.c.y, m.x - d.c.x) - d.a0) * 180) / Math.PI;
        ang = ((ang + 540) % 360) - 180;
        if (e.shiftKey) ang = Math.round(ang / 15) * 15;
        setOverlay((o) => (o.rotate ? { rotate: { ...o.rotate, angle: ang } } : o));
        break;
      }
      case 'marquee':
        setOverlay({ marquee: { a: d.start, b: m } });
        break;
      case 'node': {
        if (!d.moved && Math.hypot(m.x - d.start.x, m.y - d.start.y) * view.scale < 2) return;
        if (!d.moved) {
          d.moved = true;
          p.onBeginEdit();
        }
        const to = { x: snap(m.x, !e.altKey), y: snap(m.y, !e.altKey) };
        const moved = moveNode(d.wp, d.ref, to);
        p.onLive((items) => items.map((i) => (i.id === d.base.id ? itemWithPaths(d.base, moved) : i)));
        break;
      }
      case 'draw': {
        const q = drawPt(m, e);
        const poly = p.tool === 'polygon';
        const box = shapeBox(d.start, q, e.shiftKey || poly, poly || e.ctrlKey);
        const spec = p.tool === 'rect' ? { type: 'rect' as const } : poly ? { type: 'polygon' as const, sides: p.polygonSides } : { type: 'ellipse' as const };
        const ps = shapePaths(spec, box.w, box.h) ?? [];
        setOverlay({ ghost: ps.map((pl) => pl.map((z) => ({ x: z.x + box.x, y: z.y + box.y }))) });
        break;
      }
    }
  };

  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const { sx, sy } = local(e);
    const m = toMM(sx, sy);
    if (d.kind === 'rotate') {
      const ang = overlay.rotate?.angle ?? 0;
      setOverlay({});
      if (Math.abs(ang) > 0.01) p.onLive((items) => rotateItems(items, d.ids, ang, d.c));
    } else if (d.kind === 'marquee') {
      setOverlay({});
      const r = { minX: Math.min(d.start.x, m.x), maxX: Math.max(d.start.x, m.x), minY: Math.min(d.start.y, m.y), maxY: Math.max(d.start.y, m.y) };
      if ((r.maxX - r.minX) * view.scale < 3 && (r.maxY - r.minY) * view.scale < 3) {
        if (!d.additive) p.onSelect([]);
        return;
      }
      const crossing = m.x < d.start.x;
      const hits = p.items
        .filter((it) =>
          crossing ? itemTouchesRect(it, r) : it.x >= r.minX && it.x + it.w <= r.maxX && it.y >= r.minY && it.y + it.h <= r.maxY,
        )
        .map((i) => i.id);
      p.onSelect(d.additive ? [...new Set([...p.selectedIds, ...hits])] : hits);
    } else if (d.kind === 'draw') {
      setOverlay({});
      const q = drawPt(m, e);
      const poly = p.tool === 'polygon';
      const box = shapeBox(d.start, q, e.shiftKey || poly, poly || e.ctrlKey);
      if (box.w < 0.3 || box.h < 0.3) return;
      const spec = p.tool === 'rect' ? { type: 'rect' as const, radius: 0 } : poly ? { type: 'polygon' as const, sides: p.polygonSides } : { type: 'ellipse' as const };
      const names = { rect: t('shape.rect'), ellipse: t('shape.ellipse'), polygon: t('shape.polygon', { n: p.polygonSides }) };
      p.onCreate({
        name: names[spec.type],
        kind: 'vector',
        shape: spec,
        paths: shapePaths(spec, box.w, box.h)!,
        srcW: box.w,
        srcH: box.h,
        w: box.w,
        h: box.h,
        x: box.x,
        y: box.y,
        layerId: p.activeLayer?.id ?? 'cut',
      });
      p.onToolDone();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const { sx, sy } = local(e);
    const m = toMM(sx, sy);
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    userMoved.current = true;
    const scale = Math.min(80, Math.max(0.3, view.scale * k));
    setView({ scale, ox: sx - m.x * scale, oy: size.h - sy - m.y * scale });
  };

  const fit = () => {
    userMoved.current = false;
    const s = Math.min((size.w - 60) / p.bedW, (size.h - 60) / p.bedH);
    setView({ scale: s, ox: (size.w - p.bedW * s) / 2, oy: (size.h - p.bedH * s) / 2 });
  };

  // Test hook: convert mm to screen coordinates for simulated mouse input
  (window as any).__wsClient = (x: number, y: number) => {
    const [sx, sy] = toS(x, y);
    const r = cv.current!.getBoundingClientRect();
    return [r.left + sx, r.top + sy];
  };

  const cursorStyle = space || drag.current?.kind === 'pan' ? 'grab' : p.tool === 'select' || p.tool === 'node' ? 'default' : p.tool === 'text' ? 'text' : 'crosshair';
  const hintKey: Record<Tool, Key> = {
    select: 'hint.select',
    node: 'hint.node',
    line: 'hint.line',
    rect: 'hint.rect',
    ellipse: 'hint.ellipse',
    polygon: 'hint.polygon',
    text: 'hint.text',
  };

  return (
    <div ref={wrap} className="workspace">
      <canvas
        ref={cv}
        style={{ width: size.w, height: size.h, cursor: cursorStyle }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={(e) => {
          if (drag.current) onUp(e);
          setCursor(null);
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="ws-hint">{t(hintKey[p.tool])}</div>
      <div className="ws-coords">
        {cursor ? `X ${cursor.x.toFixed(2)}  Y ${cursor.y.toFixed(2)} mm` : ''}
        <button className="tiny" onClick={fit} title={t('ws.fitTip')}>⤢ {t('ws.fit')}</button>
      </div>
    </div>
  );
}
