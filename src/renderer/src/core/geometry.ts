import type { Anchor, Bounds, Item, Polyline, Pt } from './types';

export const uid = () => Math.random().toString(36).slice(2, 10);

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function addPt(b: Bounds, p: Pt) {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

export function pathsBounds(paths: Polyline[]): Bounds {
  const b = emptyBounds();
  for (const pl of paths) for (const p of pl) addPt(b, p);
  return b;
}

export function isEmpty(b: Bounds) {
  return !isFinite(b.minX) || b.maxX < b.minX;
}

export function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Bottom-left position of every grid copy of an object. */
export function copyOffsets(item: Item): Pt[] {
  const out: Pt[] = [];
  const { cols, rows, gapX, gapY } = item.copies;
  for (let r = 0; r < Math.max(1, rows); r++)
    for (let c = 0; c < Math.max(1, cols); c++)
      out.push({ x: item.x + c * (item.w + gapX), y: item.y + r * (item.h + gapY) });
  return out;
}

/** Bounding box of an object including its grid copies. */
export function itemBounds(item: Item): Bounds {
  const cols = Math.max(1, item.copies.cols);
  const rows = Math.max(1, item.copies.rows);
  return {
    minX: item.x,
    minY: item.y,
    maxX: item.x + cols * item.w + (cols - 1) * item.copies.gapX,
    maxY: item.y + rows * item.h + (rows - 1) * item.copies.gapY,
  };
}

export function itemsBounds(items: Item[]): Bounds {
  return items.reduce((acc, it) => union(acc, itemBounds(it)), emptyBounds());
}

/** The object's paths, scaled and placed at the given origin. */
export function placedPaths(item: Item, origin: Pt): Polyline[] {
  if (!item.paths) return [];
  const sx = item.srcW > 0 ? item.w / item.srcW : 1;
  const sy = item.srcH > 0 ? item.h / item.srcH : 1;
  return item.paths.map((pl) => pl.map((p) => ({ x: origin.x + p.x * sx, y: origin.y + p.y * sy })));
}

export function anchorPoint(b: Bounds, a: Anchor): Pt {
  const xs = { l: b.minX, c: (b.minX + b.maxX) / 2, r: b.maxX };
  const ys = { b: b.minY, c: (b.minY + b.maxY) / 2, t: b.maxY };
  const v = a.length === 2 ? a[0] : a === 't' || a === 'b' ? a : 'c';
  const h = a.length === 2 ? a[1] : a === 'l' || a === 'r' ? a : 'c';
  const y = v === 't' ? ys.t : v === 'b' ? ys.b : ys.c;
  const x = h === 'l' ? xs.l : h === 'r' ? xs.r : xs.c;
  return { x, y };
}

const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function contains(outer: Bounds, inner: Bounds) {
  return (
    outer !== inner &&
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/**
 * Cut ordering: paths inside another path are always cut before the outer outline
 * (so parts don't drop or shift); otherwise pick the nearest path to reduce travel.
 * Closed paths may start at any vertex; open paths may be reversed.
 */
export function optimizeOrder(paths: Polyline[], start: Pt = { x: 0, y: 0 }): Polyline[] {
  const items = paths
    .filter((p) => p.length > 1)
    .map((p) => ({ p, b: pathsBounds([p]), closed: dist2(p[0], p[p.length - 1]) < 1e-6 }));
  const done = new Array(items.length).fill(false);
  const out: Polyline[] = [];
  let cur = start;
  for (let n = 0; n < items.length; n++) {
    let best = -1;
    let bestD = Infinity;
    let bestIdx = 0;
    let bestRev = false;
    for (let i = 0; i < items.length; i++) {
      if (done[i]) continue;
      // An inner path is still uncut → this one must wait
      let blocked = false;
      for (let j = 0; j < items.length && !blocked; j++)
        if (!done[j] && j !== i && contains(items[i].b, items[j].b)) blocked = true;
      if (blocked) continue;
      const pl = items[i].p;
      if (items[i].closed) {
        for (let k = 0; k < pl.length - 1; k++) {
          const d = dist2(cur, pl[k]);
          if (d < bestD) (bestD = d), (best = i), (bestIdx = k), (bestRev = false);
        }
      } else {
        const d0 = dist2(cur, pl[0]);
        const d1 = dist2(cur, pl[pl.length - 1]);
        if (d0 < bestD) (bestD = d0), (best = i), (bestIdx = 0), (bestRev = false);
        if (d1 < bestD) (bestD = d1), (best = i), (bestIdx = 0), (bestRev = true);
      }
    }
    if (best < 0) {
      // Identical bounding boxes block each other: take the first uncut path
      best = done.indexOf(false);
      bestIdx = 0;
      bestRev = false;
    }
    done[best] = true;
    let pl = items[best].p;
    if (items[best].closed && bestIdx > 0) {
      const ring = pl.slice(0, -1);
      pl = [...ring.slice(bestIdx), ...ring.slice(0, bestIdx), ring[bestIdx]];
    } else if (bestRev) pl = [...pl].reverse();
    out.push(pl);
    cur = pl[pl.length - 1];
  }
  return out;
}
