import { describe, expect, it } from 'vitest';
import { frameGcode, gcodeBounds, generateJob, insideBed, jobBounds } from '../src/renderer/src/core/gcode';
import type { Raster } from '../src/renderer/src/core/raster';
import type { Item, JobOptions, Layer, MachineProfile } from '../src/renderer/src/core/types';
import { rectPath } from '../src/renderer/src/core/shapes';
import { migrateLegacyOrder } from '../src/renderer/src/core/layers';
import { parsePathData } from '../src/renderer/src/io/svgPath';

const machine: MachineProfile = { name: 'S30', laser: '10W', bedW: 410, bedH: 400, sMax: 1000, baud: 115200, frameSpeed: 3000, framePower: 1, travelSpeed: 6000 };
const abs: JobOptions = { originMode: 'absolute', anchor: 'bl', currentPos: { x: 0, y: 0 } };
const base = { minPower: 0, passes: 1, lineInterval: 0.1, dither: 'floyd' as const, threshold: 128, overscan: 2.5, bidirectional: true, enabled: true };
const cut: Layer = { ...base, id: 'cut', name: 'Cut', color: '#f00', mode: 'line', speed: 300, power: 100 };
const img: Layer = { ...base, id: 'img', name: 'Image', color: '#000', mode: 'image', speed: 3000, power: 50 };
const copies = { cols: 1, rows: 1, gapX: 5, gapY: 5 };

const square = (x: number, y: number, size = 10, layerId = 'cut', extra: Partial<Item> = {}): Item => ({
  id: `sq${x}-${y}-${Math.random()}`,
  name: 'sq',
  kind: 'vector',
  paths: [rectPath(size, size)],
  srcW: size,
  srcH: size,
  w: size,
  h: size,
  x,
  y,
  layerId,
  copies,
  ...extra,
});

const bitmapItem = (x: number, y: number, w = 20, h = 2): Item => ({
  id: `bm${x}`,
  name: 'bm',
  kind: 'bitmap',
  bitmap: { width: 1, height: 1, gray: new Uint8Array([0]), url: '' },
  srcW: w,
  srcH: h,
  w,
  h,
  x,
  y,
  layerId: 'img',
  copies,
});

/** A fully black raster, so every row is engraved edge to edge (no canvas needed). */
const blackRaster = (it: Item, l: Layer): Raster => {
  const cols = Math.round(it.w / l.lineInterval);
  const rows = Math.round(it.h / l.lineInterval);
  return { cols, rows, data: new Float32Array(cols * rows).fill(1), px: it.w / cols, py: it.h / rows };
};

describe('toolpath bounds', () => {
  it('never commands negative X when an image starts closer to the edge than the overscan', () => {
    const j = generateJob([bitmapItem(1, 10)], [img], machine, abs, { rasterize: blackRaster });
    expect(j.motion.minX).toBeGreaterThanOrEqual(0);
    expect(insideBed(j.motion, machine)).toBe(true);
  });

  it('keeps the full overscan away from the edges', () => {
    // Run from the current position so the final return move stays inside the engraved area
    const here: JobOptions = { originMode: 'current', anchor: 'bl', currentPos: { x: 50, y: 10 } };
    const j = generateJob([bitmapItem(50, 10)], [img], machine, here, { rasterize: blackRaster });
    expect(j.motion.minX).toBeCloseTo(47.5, 5);
    expect(j.motion.maxX).toBeCloseTo(72.5, 5);
  });

  it('never commands X beyond the bed width at the right edge', () => {
    const j = generateJob([bitmapItem(machine.bedW - 21, 10)], [img], machine, abs, { rasterize: blackRaster });
    expect(j.motion.maxX).toBeLessThanOrEqual(machine.bedW);
  });

  it('includes the return move to the start position', () => {
    const cur: JobOptions = { originMode: 'current', anchor: 'c', currentPos: { x: 300, y: 350 } };
    const j = generateJob([square(10, 10)], [cut], machine, cur);
    expect(j.motion.maxY).toBeGreaterThanOrEqual(350);
  });

  it('reports a design outside the bed', () => {
    const j = generateJob([square(-5, 10)], [cut], machine, abs);
    expect(insideBed(j.motion, machine)).toBe(false);
  });

  it('gcodeBounds ignores coordinate-system setup commands', () => {
    expect(gcodeBounds(['G10 L20 P1 X-50 Y-50', 'G0 X1 Y2', 'G1 X3'])).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 2 });
  });

  it('frames exactly the job bounds', () => {
    const items = [square(20, 30), square(100, 120)];
    const f = gcodeBounds(frameGcode(items, machine, abs));
    expect(f).toEqual(jobBounds(items, abs));
  });
});

describe('layer order and overrides', () => {
  const order = (lines: string[]) => lines.filter((l) => l.startsWith('; ---- Layer')).map((l) => l.split(' ')[3]);

  it('runs layers in list order', () => {
    const items = [square(10, 10), bitmapItem(100, 100)];
    expect(order(generateJob(items, [img, cut], machine, abs, { rasterize: blackRaster }).lines)).toEqual(['img', 'cut']);
    expect(order(generateJob(items, [cut, img], machine, abs, { rasterize: blackRaster }).lines)).toEqual(['cut', 'img']);
  });

  it('skips disabled layers', () => {
    const lines = generateJob([square(10, 10)], [{ ...cut, enabled: false }], machine, abs).lines;
    expect(lines.some((l) => /^G1 /.test(l))).toBe(false);
  });

  it('gives objects with an override their own speed and power', () => {
    const items = [square(10, 10, 10, 'cut', { override: { speed: 1234, power: 40 } }), square(30, 10)];
    const lines = generateJob(items, [cut], machine, abs).lines;
    expect(lines.some((l) => / F1234\b/.test(l) && / S400\b/.test(l))).toBe(true); // 40% of S1000
    expect(lines.some((l) => / F300\b/.test(l) && / S1000\b/.test(l))).toBe(true);
  });

  it('cuts inner shapes before the outline around them', () => {
    const outer = square(0, 0, 50);
    const inner = square(20, 20, 5);
    const lines = generateJob([outer, inner], [cut], machine, abs).lines;
    const firstMove = lines.find((l) => l.startsWith('G0'))!;
    expect(firstMove).toMatch(/X2\d/); // starts on the inner square (x 20–25)
  });

  it('migrates legacy layer lists to the old fixed run order', () => {
    const score: Layer = { ...cut, id: 'score' };
    const fill: Layer = { ...cut, id: 'fill', mode: 'fill' };
    expect(migrateLegacyOrder([cut, score, fill, img]).map((l) => l.id)).toEqual(['img', 'fill', 'cut', 'score']);
  });
});

describe('SVG path parsing', () => {
  it('closes paths on Z', () => {
    const [pl] = parsePathData('M0 0 L10 0 L10 10 Z');
    expect(pl[0]).toEqual(pl[pl.length - 1]);
  });

  it('reads compact arc flags', () => {
    const [pl] = parsePathData('M0 0 a5 5 0 0110 0');
    expect(pl[pl.length - 1].x).toBeCloseTo(10, 6);
  });

  it('splits subpaths', () => {
    expect(parsePathData('M0 0 L1 1 M5 5 L6 6')).toHaveLength(2);
  });
});

describe('air assist and kerf in jobs', () => {
  const withAir: MachineProfile = { ...machine, airAssist: true };
  const engrave: Layer = { ...cut, id: 'eng', speed: 3000, power: 30, air: false };
  const cutAir: Layer = { ...cut, air: true };

  it('emits M8/M9 per layer and switches air off at the end when the machine has air assist', () => {
    const lines = generateJob([square(10, 10, 10, 'eng'), square(40, 10)], [engrave, cutAir], withAir, abs).lines;
    const air = lines.filter((l) => l === 'M8' || l === 'M9');
    expect(air).toEqual(['M9', 'M8', 'M9']); // engrave off, cut on, off at the end
    expect(lines.indexOf('M8')).toBeLessThan(lines.findIndex((l) => / F300\b/.test(l)));
  });

  it('never emits M8/M9 when the machine has no air assist configured', () => {
    const lines = generateJob([square(40, 10)], [cutAir], machine, abs).lines;
    expect(lines.some((l) => l === 'M8' || l === 'M9')).toBe(false);
  });

  it('applies the layer kerf to cut paths', () => {
    const here: JobOptions = { originMode: 'current', anchor: 'bl', currentPos: { x: 10, y: 10 } };
    const j = generateJob([square(10, 10, 20)], [{ ...cut, kerf: 0.2 }], machine, here);
    expect(j.motion.minX).toBeCloseTo(9.9, 6);
    expect(j.motion.maxX).toBeCloseTo(30.1, 6);
  });
});
