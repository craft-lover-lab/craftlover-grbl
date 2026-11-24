import { describe, expect, it } from 'vitest';
import { kerfFromMeasurement, kerfOffset } from '../src/renderer/src/core/kerf';
import { pathsBounds } from '../src/renderer/src/core/geometry';
import { rectPath } from '../src/renderer/src/core/shapes';
import type { Polyline } from '../src/renderer/src/core/types';

const move = (pl: Polyline, dx: number, dy: number) => pl.map((p) => ({ x: p.x + dx, y: p.y + dy }));
const size = (pl: Polyline) => {
  const b = pathsBounds([pl]);
  return [+(b.maxX - b.minX).toFixed(4), +(b.maxY - b.minY).toFixed(4)];
};

describe('kerf compensation', () => {
  it('grows a part outline by half the kerf on every side, keeping square corners', () => {
    const [out] = kerfOffset([rectPath(20, 10)], 0.2);
    expect(size(out)).toEqual([20.2, 10.2]);
    expect(out.length - 1).toBe(4); // still 4 corners (mitred, not rounded)
    expect(out[0]).toEqual(out[out.length - 1]); // stays closed
  });

  it('shrinks a hole and grows the part around it', () => {
    const outer = rectPath(40, 40);
    const hole = move(rectPath(10, 10), 15, 15);
    const [o, h] = kerfOffset([outer, hole], 0.2);
    expect(size(o)).toEqual([40.2, 40.2]);
    expect(size(h)).toEqual([9.8, 9.8]);
  });

  it('treats an island inside a hole as a part again', () => {
    const outer = rectPath(60, 60);
    const hole = move(rectPath(40, 40), 10, 10);
    const island = move(rectPath(10, 10), 25, 25);
    const [, , i] = kerfOffset([outer, hole, island], 0.4);
    expect(size(i)).toEqual([10.4, 10.4]);
  });

  it('leaves open paths and zero kerf untouched', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(kerfOffset([line], 0.2)).toEqual([line]);
    const sq = rectPath(5, 5);
    expect(kerfOffset([sq], 0)).toEqual([sq]);
  });

  it('keeps a hole that is narrower than the kerf instead of dropping the cut', () => {
    const outer = rectPath(20, 20);
    const slot = move(rectPath(0.1, 5), 10, 5);
    const res = kerfOffset([outer, slot], 0.3);
    expect(res).toHaveLength(2);
    expect(size(res[1])).toEqual([0.1, 5]);
  });

  it('computes the kerf from a measured test square', () => {
    expect(kerfFromMeasurement(20, 19.84)).toBeCloseTo(0.16, 6);
    expect(kerfFromMeasurement(20, 20.1)).toBe(0);
  });
});
