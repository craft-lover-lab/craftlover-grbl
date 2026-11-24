import { describe, expect, it } from 'vitest';
import { booleanPaths } from '../src/renderer/src/core/boolean';
import { deleteNode, hitNode, hitSegment, insertNode, itemWithPaths, moveNode, worldPaths } from '../src/renderer/src/core/nodes';
import { pathsBounds } from '../src/renderer/src/core/geometry';
import { rectPath } from '../src/renderer/src/core/shapes';
import type { Item, Polyline } from '../src/renderer/src/core/types';

const move = (pl: Polyline, dx: number, dy: number) => pl.map((p) => ({ x: p.x + dx, y: p.y + dy }));
/** Even-odd area of a set of closed paths (shoelace, signed per path, holes subtract when oriented opposite) */
const area = (paths: Polyline[]) => paths.reduce((s, pl) => s + pl.slice(1).reduce((a, p, i) => a + (pl[i].x * p.y - p.x * pl[i].y), 0) / 2, 0);

describe('boolean operations', () => {
  const a = [rectPath(10, 10)];
  const b = [move(rectPath(10, 10), 5, 0)];
  it('union welds overlapping squares into one outline', () => {
    const r = booleanPaths('union', [a, b]);
    expect(r.paths).toHaveLength(1);
    expect(Math.abs(area(r.paths))).toBeCloseTo(150, 3);
    const bb = pathsBounds(r.paths);
    expect([bb.minX, bb.maxX, bb.minY, bb.maxY]).toEqual([0, 15, 0, 10]);
    expect(r.paths[0][0]).toEqual(r.paths[0][r.paths[0].length - 1]); // closed
  });
  it('subtract removes the others from the first', () => {
    const r = booleanPaths('subtract', [a, b]);
    expect(Math.abs(area(r.paths))).toBeCloseTo(50, 3);
    const bb = pathsBounds(r.paths);
    expect([bb.minX, bb.maxX]).toEqual([0, 5]);
  });
  it('subtracting an inner square leaves a hole', () => {
    const r = booleanPaths('subtract', [a, [move(rectPath(4, 4), 3, 3)]]);
    expect(r.paths).toHaveLength(2);
    expect(Math.abs(area(r.paths))).toBeCloseTo(100 - 16, 3);
  });
  it('intersect keeps only the shared area', () => {
    const r = booleanPaths('intersect', [a, b, [move(rectPath(10, 10), 0, 5)]]);
    expect(Math.abs(area(r.paths))).toBeCloseTo(25, 3);
  });
  it('intersect of disjoint shapes is empty', () => {
    expect(booleanPaths('intersect', [a, [move(rectPath(2, 2), 50, 50)]]).paths).toHaveLength(0);
  });
  it('keeps holes of each object (even-odd), e.g. a ring', () => {
    const ring = [rectPath(10, 10), move(rectPath(4, 4), 3, 3)];
    const r = booleanPaths('union', [ring, [move(rectPath(2, 2), 20, 0)]]);
    expect(Math.abs(area(r.paths))).toBeCloseTo(100 - 16 + 4, 3);
  });
  it('ignores open lines and reports them', () => {
    const r = booleanPaths('union', [a, [[{ x: 0, y: 0 }, { x: 30, y: 30 }]]]);
    expect(r.openIgnored).toBe(1);
    expect(Math.abs(area(r.paths))).toBeCloseTo(100, 3);
  });
});

describe('node editing', () => {
  const sq = rectPath(10, 10); // closed: 5 points
  it('moving the first node of a closed path keeps it closed', () => {
    const [pl] = moveNode([sq], { pi: 0, ni: 0 }, { x: -2, y: -2 });
    expect(pl[0]).toEqual({ x: -2, y: -2 });
    expect(pl[pl.length - 1]).toEqual({ x: -2, y: -2 });
  });
  it('deletes a corner of a square → triangle, then the path disappears below 3 corners', () => {
    let p = deleteNode([sq], { pi: 0, ni: 1 });
    expect(p[0]).toHaveLength(4);
    expect(p[0][0]).toEqual(p[0][3]);
    p = deleteNode(p, { pi: 0, ni: 0 });
    expect(p).toHaveLength(0);
  });
  it('open paths keep at least two points', () => {
    const line = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }];
    expect(deleteNode([line], { pi: 0, ni: 1 })[0]).toHaveLength(2);
    expect(deleteNode([[line[0], line[1]]], { pi: 0, ni: 0 })).toHaveLength(0);
  });
  it('inserts a node on a segment and finds nodes/segments near the mouse', () => {
    const s = hitSegment([sq], { x: 5, y: 0.3 }, 0.5)!;
    expect(s.seg).toBe(0);
    const r = insertNode([sq], s.pi, s.seg, s.p);
    expect(r.paths[0]).toHaveLength(6);
    expect(r.paths[0][r.node.ni]).toEqual({ x: 5, y: 0 });
    expect(hitNode(r.paths, { x: 5.2, y: 0.1 }, 0.5)).toEqual({ pi: 0, ni: 1 });
    expect(hitNode(r.paths, { x: 5, y: 5 }, 0.5)).toBeNull();
  });
  it('rebuilds a scaled object around edited bed-coordinate paths', () => {
    const it0: Item = { id: 'a', name: 'r', kind: 'vector', shape: { type: 'rect', radius: 0 }, paths: [sq], srcW: 10, srcH: 10, w: 20, h: 20, x: 100, y: 50, layerId: 'cut', copies: { cols: 1, rows: 1, gapX: 5, gapY: 5 } };
    const wp = worldPaths(it0);
    expect(pathsBounds(wp)).toEqual({ minX: 100, minY: 50, maxX: 120, maxY: 70 });
    const moved = moveNode(wp, { pi: 0, ni: 2 }, { x: 130, y: 80 });
    const it1 = itemWithPaths(it0, moved);
    expect([it1.x, it1.y, it1.w, it1.h]).toEqual([100, 50, 30, 30]);
    expect(it1.shape).toBeUndefined();
    expect(pathsBounds(worldPaths(it1))).toEqual({ minX: 100, minY: 50, maxX: 130, maxY: 80 });
  });
});
