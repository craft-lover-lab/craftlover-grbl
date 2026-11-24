import type { Item, Polyline, Pt } from './types';
import { pathsBounds, uid } from './geometry';
import { isClosedPath, itemWithPaths, worldPaths } from './nodes';

const COPIES_1 = { cols: 1, rows: 1, gapX: 5, gapY: 5 };

function inside(p: Pt, poly: Polyline) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Split paths into separate parts the way they look on the canvas (even-odd fill):
 * every outline becomes its own part together with the holes directly inside it, so a
 * letter "O" or a frame with a window stays one part. An island inside a hole is a part
 * of its own again. Every open path (a line) is a part of its own.
 */
export function splitParts(paths: Polyline[]): Polyline[][] {
  const closed = paths.map((pl, i) => ({ pl, i, b: pathsBounds([pl]), closed: isClosedPath(pl) && pl.length > 3 }));
  const parts = new Map<number, Polyline[]>();
  const order: number[] = [];
  const container = (k: number) => {
    // All closed paths that contain path k, smallest first
    const me = closed[k];
    const hits = closed.filter(
      (o) =>
        o.i !== k &&
        o.closed &&
        o.b.minX <= me.b.minX &&
        o.b.maxX >= me.b.maxX &&
        o.b.minY <= me.b.minY &&
        o.b.maxY >= me.b.maxY &&
        (o.b.maxX - o.b.minX) * (o.b.maxY - o.b.minY) > (me.b.maxX - me.b.minX) * (me.b.maxY - me.b.minY) &&
        inside(me.pl[0], o.pl),
    );
    hits.sort((a, c) => (a.b.maxX - a.b.minX) * (a.b.maxY - a.b.minY) - (c.b.maxX - c.b.minX) * (c.b.maxY - c.b.minY));
    return hits;
  };
  const owner = new Map<number, number>();
  // Outlines (even depth) own themselves; holes (odd depth) belong to their direct container
  for (const c of closed) {
    if (!c.closed) {
      owner.set(c.i, c.i);
      continue;
    }
    const hits = container(c.i);
    owner.set(c.i, hits.length % 2 === 1 ? hits[0].i : c.i);
  }
  for (const c of closed) {
    const o = owner.get(c.i)!;
    if (!parts.has(o)) {
      parts.set(o, []);
      order.push(o);
    }
  }
  // Keep the original path order inside each part (outline first when it came first)
  for (const c of closed) parts.get(owner.get(c.i)!)!.push(c.pl);
  return order.map((o) => parts.get(o)!).filter((p) => p.length);
}

/** Ungroup: one object per part, on the same layer and at the same place. Returns [] when there is nothing to split. */
export function ungroupItem(it: Item): Item[] {
  if (it.kind !== 'vector' || !it.paths?.length) return [];
  const parts = splitParts(worldPaths(it));
  if (parts.length < 2) return [];
  return parts.map((pp, k) =>
    itemWithPaths({ ...it, id: uid(), name: `${it.name} · ${k + 1}`, copies: COPIES_1 }, pp),
  );
}

/** Group vector objects of ONE layer into a single object (paths kept as they are placed). */
export function groupItems(items: Item[], name: string): Item | null {
  const vec = items.filter((i) => i.kind === 'vector' && i.paths?.length);
  if (vec.length < 2 || new Set(vec.map((i) => i.layerId)).size > 1) return null;
  return itemWithPaths({ ...vec[0], id: uid(), name, copies: COPIES_1, override: undefined }, vec.flatMap(worldPaths));
}
