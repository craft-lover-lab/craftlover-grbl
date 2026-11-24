import type { Item, Polyline, Pt } from './types';
import { isEmpty, pathsBounds, placedPaths } from './geometry';

/** Node editing works on an object's paths in bed coordinates (mm). */

export interface NodeRef {
  /** Path index */
  pi: number;
  /** Vertex index */
  ni: number;
}

const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
export const isClosedPath = (pl: Polyline) => pl.length > 2 && near(pl[0], pl[pl.length - 1]);

/** Vertices a user can grab: a closed path's last point is the same node as its first. */
export function nodeCount(pl: Polyline) {
  return isClosedPath(pl) ? pl.length - 1 : pl.length;
}

/** The object's paths placed on the bed. */
export const worldPaths = (it: Item) => placedPaths(it, { x: it.x, y: it.y });

/**
 * Rebuild an object from edited bed-coordinate paths: the paths become its new source
 * (scale 1:1) and the box is fitted around them. A drawn shape or text loses its
 * parameters, since it is no longer that shape.
 */
export function itemWithPaths(it: Item, paths: Polyline[]): Item {
  const b = pathsBounds(paths);
  if (isEmpty(b)) return it;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return {
    ...it,
    shape: undefined,
    text: undefined,
    paths: paths.map((pl) => pl.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }))),
    srcW: w,
    srcH: h,
    w,
    h,
    x: b.minX,
    y: b.minY,
  };
}

export function moveNode(paths: Polyline[], r: NodeRef, to: Pt): Polyline[] {
  return paths.map((pl, pi) => {
    if (pi !== r.pi) return pl;
    const closed = isClosedPath(pl);
    return pl.map((p, ni) => (ni === r.ni || (closed && ((r.ni === 0 && ni === pl.length - 1) || (r.ni === pl.length - 1 && ni === 0))) ? { ...to } : p));
  });
}

/**
 * Delete a node. A closed path keeps at least 3 corners and an open one 2 points;
 * deleting below that removes the whole path.
 */
export function deleteNode(paths: Polyline[], r: NodeRef): Polyline[] {
  const out: Polyline[] = [];
  paths.forEach((pl, pi) => {
    if (pi !== r.pi) return out.push(pl);
    if (isClosedPath(pl)) {
      const ring = pl.slice(0, -1).filter((_, i) => i !== r.ni % (pl.length - 1));
      if (ring.length >= 3) out.push([...ring, { ...ring[0] }]);
    } else {
      const rest = pl.filter((_, i) => i !== r.ni);
      if (rest.length >= 2) out.push(rest);
    }
  });
  return out;
}

/** Insert a node at `p` on the segment that starts at vertex `seg`; returns the new paths and node. */
export function insertNode(paths: Polyline[], pi: number, seg: number, p: Pt): { paths: Polyline[]; node: NodeRef } {
  const out = paths.map((pl, i) => (i === pi ? [...pl.slice(0, seg + 1), { ...p }, ...pl.slice(seg + 1)] : pl));
  return { paths: out, node: { pi, ni: seg + 1 } };
}

/** Nearest node within `tol` (mm). */
export function hitNode(paths: Polyline[], m: Pt, tol: number): NodeRef | null {
  let best: NodeRef | null = null;
  let bestD = tol;
  paths.forEach((pl, pi) => {
    const n = nodeCount(pl);
    for (let ni = 0; ni < n; ni++) {
      const d = Math.hypot(pl[ni].x - m.x, pl[ni].y - m.y);
      if (d <= bestD) (bestD = d), (best = { pi, ni });
    }
  });
  return best;
}

/** Nearest segment within `tol` (mm) and the closest point on it. */
export function hitSegment(paths: Polyline[], m: Pt, tol: number): { pi: number; seg: number; p: Pt } | null {
  let best: { pi: number; seg: number; p: Pt } | null = null;
  let bestD = tol;
  paths.forEach((pl, pi) => {
    for (let k = 1; k < pl.length; k++) {
      const a = pl[k - 1];
      const b = pl[k];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / l2)) : 0;
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(m.x - q.x, m.y - q.y);
      if (d <= bestD) (bestD = d), (best = { pi, seg: k - 1, p: q });
    }
  });
  return best;
}
