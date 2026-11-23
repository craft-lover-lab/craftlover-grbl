import type { Anchor, Bounds, Item, Pt } from '../core/types';
import { anchorPoint, emptyBounds, placedPaths, union, uid } from '../core/geometry';
import { transformItem } from '../core/transform';

/** Bounding box of the selected objects (grid copies excluded). */
export function selBounds(items: Item[]): Bounds {
  return items.reduce((b, it) => union(b, { minX: it.x, minY: it.y, maxX: it.x + it.w, maxY: it.y + it.h }), emptyBounds());
}

export function moveItems(items: Item[], ids: Set<string>, dx: number, dy: number): Item[] {
  return items.map((i) => (ids.has(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i));
}

/** Scale objects around the fixed point `fix` by sx, sy. */
export function scaleItems(base: Item[], ids: Set<string>, fix: Pt, sx: number, sy: number): Item[] {
  return base.map((i) =>
    ids.has(i.id)
      ? {
          ...i,
          x: fix.x + (i.x - fix.x) * sx,
          y: fix.y + (i.y - fix.y) * sy,
          w: Math.max(0.05, i.w * sx),
          h: Math.max(0.05, i.h * sy),
        }
      : i,
  );
}

/** Rotate a group of objects around center `c` (degrees, counter-clockwise). */
export function rotateItems(items: Item[], ids: Set<string>, angle: number, c: Pt): Item[] {
  const t = (angle * Math.PI) / 180;
  return items.map((i) => {
    if (!ids.has(i.id)) return i;
    const ic = { x: i.x + i.w / 2, y: i.y + i.h / 2 };
    const r = transformItem(i, angle);
    const nc = {
      x: c.x + (ic.x - c.x) * Math.cos(t) - (ic.y - c.y) * Math.sin(t),
      y: c.y + (ic.x - c.x) * Math.sin(t) + (ic.y - c.y) * Math.cos(t),
    };
    return { ...r, shape: angle % 360 === 0 ? i.shape : undefined, x: nc.x - r.w / 2, y: nc.y - r.h / 2 };
  });
}

/** Flip a group across the vertical/horizontal axis through its center. */
export function flipItems(items: Item[], ids: Set<string>, fx: boolean, fy: boolean): Item[] {
  const b = selBounds(items.filter((i) => ids.has(i.id)));
  return items.map((i) => {
    if (!ids.has(i.id)) return i;
    const r = transformItem(i, 0, fx, fy);
    return { ...r, x: fx ? b.minX + b.maxX - i.x - i.w : i.x, y: fy ? b.minY + b.maxY - i.y - i.h : i.y };
  });
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignItems(items: Item[], ids: Set<string>, mode: AlignMode, target?: Bounds): Item[] {
  const sel = items.filter((i) => ids.has(i.id));
  const b = target ?? selBounds(sel);
  return items.map((i) => {
    if (!ids.has(i.id)) return i;
    switch (mode) {
      case 'left':
        return { ...i, x: b.minX };
      case 'right':
        return { ...i, x: b.maxX - i.w };
      case 'hcenter':
        return { ...i, x: (b.minX + b.maxX) / 2 - i.w / 2 };
      case 'bottom':
        return { ...i, y: b.minY };
      case 'top':
        return { ...i, y: b.maxY - i.h };
      case 'vcenter':
        return { ...i, y: (b.minY + b.maxY) / 2 - i.h / 2 };
    }
  });
}

/** Space objects evenly along X or Y. */
export function distributeItems(items: Item[], ids: Set<string>, axis: 'x' | 'y'): Item[] {
  const sel = items.filter((i) => ids.has(i.id));
  if (sel.length < 3) return items;
  const key = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = [...sel].sort((a, b) => a[key] - b[key]);
  const first = sorted[0][key];
  const last = sorted[sorted.length - 1][key] + sorted[sorted.length - 1][size];
  const total = sorted.reduce((s, i) => s + i[size], 0);
  const gap = (last - first - total) / (sorted.length - 1);
  const pos = new Map<string, number>();
  let cur = first;
  for (const i of sorted) {
    pos.set(i.id, cur);
    cur += i[size] + gap;
  }
  return items.map((i) => (pos.has(i.id) ? { ...i, [key]: pos.get(i.id)! } : i));
}

export function cloneItems(src: Item[], dx: number, dy: number): Item[] {
  return src.map((i) => ({ ...i, id: uid(), x: i.x + dx, y: i.y + dy }));
}

/** Reference point of the selection box for one of the 9 anchors. */
export const refPoint = (b: Bounds, a: Anchor) => anchorPoint(b, a);

/** Distance from a point to a line segment. */
function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insideEvenOdd(p: Pt, paths: Pt[][]) {
  let inside = false;
  for (const pl of paths)
    for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) {
      const a = pl[i];
      const b = pl[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}

/**
 * Hit test: images → anywhere inside the box;
 * vectors → near a stroke (tol mm), or inside a closed area when the layer is in fill mode.
 */
export function hitItem(it: Item, p: Pt, tol: number, filled: boolean): boolean {
  if (p.x < it.x - tol || p.x > it.x + it.w + tol || p.y < it.y - tol || p.y > it.y + it.h + tol) return false;
  if (it.kind === 'bitmap') return true;
  // Objects only a few pixels big: hitting the box is enough
  if (it.w < tol * 3 && it.h < tol * 3) return true;
  const paths = placedPaths(it, { x: it.x, y: it.y });
  for (const pl of paths) for (let k = 1; k < pl.length; k++) if (segDist(p, pl[k - 1], pl[k]) <= tol) return true;
  return filled && insideEvenOdd(p, paths);
}

/** Does the object intersect the rectangle? (used for crossing selection) */
export function itemTouchesRect(it: Item, r: Bounds): boolean {
  if (it.x > r.maxX || it.x + it.w < r.minX || it.y > r.maxY || it.y + it.h < r.minY) return false;
  if (it.kind === 'bitmap') return true;
  const inR = (q: Pt) => q.x >= r.minX && q.x <= r.maxX && q.y >= r.minY && q.y <= r.maxY;
  for (const pl of placedPaths(it, { x: it.x, y: it.y })) {
    for (const q of pl) if (inR(q)) return true;
    // Segment crosses an edge of the rectangle
    for (let k = 1; k < pl.length; k++) if (segHitsRect(pl[k - 1], pl[k], r)) return true;
  }
  return false;
}

function segHitsRect(a: Pt, b: Pt, r: Bounds) {
  const edges: [Pt, Pt][] = [
    [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }],
    [{ x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }],
    [{ x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }],
    [{ x: r.minX, y: r.maxY }, { x: r.minX, y: r.minY }],
  ];
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  return edges.some(([c, d]) => cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0);
}
