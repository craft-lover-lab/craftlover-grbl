import { describe, expect, it } from 'vitest';
import { groupItems, splitParts, ungroupItem } from '../src/renderer/src/core/group';
import { pathsBounds } from '../src/renderer/src/core/geometry';
import { worldPaths } from '../src/renderer/src/core/nodes';
import { rectPath } from '../src/renderer/src/core/shapes';
import type { Item, Polyline } from '../src/renderer/src/core/types';

const move = (pl: Polyline, dx: number, dy: number) => pl.map((p) => ({ x: p.x + dx, y: p.y + dy }));
const item = (paths: Polyline[], extra: Partial<Item> = {}): Item => {
  const b = pathsBounds(paths);
  return { id: 'i', name: 'design', kind: 'vector', paths, srcW: b.maxX, srcH: b.maxY, w: b.maxX, h: b.maxY, x: 0, y: 0, layerId: 'cut', copies: { cols: 1, rows: 1, gapX: 5, gapY: 5 }, ...extra };
};

describe('ungroup', () => {
  it('splits side-by-side shapes into separate parts', () => {
    const parts = splitParts([rectPath(10, 10), move(rectPath(10, 10), 20, 0), move(rectPath(5, 5), 40, 0)]);
    expect(parts).toHaveLength(3);
  });

  it('keeps holes with their outline (a frame stays one part), islands become parts again', () => {
    const frame = rectPath(30, 30);
    const hole = move(rectPath(20, 20), 5, 5);
    const island = move(rectPath(4, 4), 13, 13);
    const parts = splitParts([frame, hole, island]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual([frame, hole]);
    expect(parts[1]).toEqual([island]);
  });

  it('open lines are parts of their own', () => {
    expect(splitParts([rectPath(10, 10), [{ x: 0, y: 20 }, { x: 10, y: 20 }]])).toHaveLength(2);
  });

  it('ungrouped objects stay exactly where they were, scaled the same', () => {
    const it0 = item([rectPath(10, 10), move(rectPath(10, 10), 20, 0)], { x: 100, y: 50, w: 60, h: 20 }); // scaled ×2
    it0.srcW = 30;
    it0.srcH = 10;
    const parts = ungroupItem(it0);
    expect(parts).toHaveLength(2);
    expect(pathsBounds(worldPaths(parts[0]))).toEqual({ minX: 100, minY: 50, maxX: 120, maxY: 70 });
    expect(pathsBounds(worldPaths(parts[1]))).toEqual({ minX: 140, minY: 50, maxX: 160, maxY: 70 });
    expect(new Set(parts.map((p) => p.id)).size).toBe(2);
    expect(parts.every((p) => p.layerId === 'cut')).toBe(true);
  });

  it('nothing to ungroup for a single shape', () => {
    expect(ungroupItem(item([rectPath(10, 10)]))).toEqual([]);
  });
});

describe('group', () => {
  it('groups objects of one layer and keeps their placement', () => {
    const a = item([rectPath(10, 10)], { id: 'a', x: 0, y: 0 });
    const b = item([rectPath(10, 10)], { id: 'b', x: 30, y: 5 });
    const g = groupItems([a, b], 'G')!;
    expect(pathsBounds(worldPaths(g))).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 15 });
    expect(g.paths).toHaveLength(2);
  });

  it('refuses objects on different layers', () => {
    const a = item([rectPath(10, 10)], { id: 'a' });
    const b = item([rectPath(10, 10)], { id: 'b', layerId: 'fill' });
    expect(groupItems([a, b], 'G')).toBeNull();
  });
});
