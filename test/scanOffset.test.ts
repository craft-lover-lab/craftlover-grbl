import { describe, expect, it } from 'vitest';
import { generateJob } from '../src/renderer/src/core/gcode';
import type { Raster } from '../src/renderer/src/core/raster';
import type { Item, JobOptions, Layer, MachineProfile } from '../src/renderer/src/core/types';
import { rectPath } from '../src/renderer/src/core/shapes';
import { cleanScanOffsets, scanOffsetFor } from '../src/renderer/src/core/scanOffset';
import { barPaths, buildTestGrid, DEFAULT_TEST, rowValues } from '../src/renderer/src/core/testGrid';

const machine: MachineProfile = { name: 'S30', laser: '10W', bedW: 410, bedH: 400, sMax: 1000, baud: 115200, frameSpeed: 3000, framePower: 1, travelSpeed: 6000 };
const abs: JobOptions = { originMode: 'absolute', anchor: 'bl', currentPos: { x: 0, y: 0 } };
const fill: Layer = { id: 'f', name: 'Fill', color: '#000', mode: 'fill', speed: 3000, power: 40, minPower: 0, passes: 1, lineInterval: 1, dither: 'floyd', threshold: 128, overscan: 2, bidirectional: true, enabled: true };
const sq: Item = { id: 'a', name: 'a', kind: 'vector', paths: [rectPath(10, 4)], srcW: 10, srcH: 4, w: 10, h: 4, x: 50, y: 50, layerId: 'f', copies: { cols: 1, rows: 1, gapX: 0, gapY: 0 } };
const black = (it: Item, l: Layer): Raster => {
  const cols = Math.round(it.w / l.lineInterval);
  const rows = Math.round(it.h / l.lineInterval);
  return { cols, rows, data: new Float32Array(cols * rows).fill(1), px: it.w / cols, py: it.h / rows };
};
/** X where the beam switches on (first S>0 segment start) for each scan line, with its direction */
function burnStarts(lines: string[]) {
  const out: { from: number; to: number }[] = [];
  let x = 0;
  for (const l of lines) {
    const m = l.match(/^G1 X([-\d.]+)(?: Y[-\d.]+)? S(\d+)/);
    const g0 = l.match(/^G0 X([-\d.]+)/);
    if (g0) x = +g0[1];
    if (!m) continue;
    const nx = +m[1];
    if (+m[2] > 0 && !/Y/.test(l)) out.push({ from: x, to: nx });
    x = nx;
  }
  return out;
}

describe('scan offset table', () => {
  const m = { scanOffsets: [{ speed: 2000, offset: 0.1 }, { speed: 4000, offset: 0.2 }] };
  it('interpolates between measured speeds and scales outside them', () => {
    expect(scanOffsetFor(m, 3000)).toBeCloseTo(0.15);
    expect(scanOffsetFor(m, 1000)).toBeCloseTo(0.05);
    expect(scanOffsetFor(m, 6000)).toBeCloseTo(0.3);
    expect(scanOffsetFor({}, 3000)).toBe(0);
  });
  it('cleans the table (sorted, one row per speed, bad rows dropped)', () => {
    expect(cleanScanOffsets([{ speed: 3000, offset: 0.1 }, { speed: 1000, offset: 0.05 }, { speed: 0, offset: 1 }, { speed: 3000, offset: 0.12 }])).toEqual([
      { speed: 1000, offset: 0.05 },
      { speed: 3000, offset: 0.12 },
    ]);
  });
});

describe('scan offset in the G-code', () => {
  it('shifts lines going right to the left and lines going left to the right', () => {
    const j = generateJob([sq], [fill], { ...machine, scanOffsets: [{ speed: 3000, offset: 0.2 }] }, abs, { rasterize: black });
    const b = burnStarts(j.lines);
    expect(b.length).toBe(4);
    // Left to right: burns from 49.8 to 59.8; right to left: from 60.2 to 50.2
    expect(b[0]).toEqual({ from: 49.8, to: 59.8 });
    expect(b[1]).toEqual({ from: 60.2, to: 50.2 });
  });
  it('does nothing without a table or when engraving one way', () => {
    const plain = burnStarts(generateJob([sq], [fill], machine, abs, { rasterize: black }).lines);
    expect(plain[1]).toEqual({ from: 60, to: 50 });
    const oneWay = burnStarts(generateJob([sq], [{ ...fill, bidirectional: false }], { ...machine, scanOffsets: [{ speed: 3000, offset: 0.2 }] }, abs, { rasterize: black }).lines);
    expect(oneWay.every((l) => l.from === 50 && l.to === 60)).toBe(true);
  });
  it('a test cell override wins over the machine table', () => {
    const it2 = { ...sq, override: { scanOffset: 0 } };
    const b = burnStarts(generateJob([it2], [fill], { ...machine, scanOffsets: [{ speed: 3000, offset: 0.2 }] }, abs, { rasterize: black }).lines);
    expect(b[1]).toEqual({ from: 60, to: 50 });
  });
});

describe('fill + outline', () => {
  it('traces the outline after the fill only when switched on', () => {
    const off = generateJob([sq], [fill], machine, abs, { rasterize: black }).lines;
    const on = generateJob([sq], [{ ...fill, outline: true }], machine, abs, { rasterize: black }).lines;
    expect(off.some((l) => l === '; Outline')).toBe(false);
    const k = on.indexOf('; Outline');
    expect(k).toBeGreaterThan(0);
    const after = on.slice(k);
    expect(after.some((l) => /^G1 X[\d.]+ Y[\d.]+ S400/.test(l))).toBe(true);
    // Outline corners are the square's corners
    expect(after.join('\n')).toMatch(/X60 Y54/);
  });
});

describe('scan offset test grid', () => {
  it('rows are offsets, every cell is vertical bars with its own offset', async () => {
    const o = { ...DEFAULT_TEST, mode: 'scan' as const, cols: 3, rows: 6, labels: false };
    expect(rowValues(o)).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25]);
    const r = await buildTestGrid(o, { cells: 'c', labels: 'l', cell: () => 'x', speedAxis: 's', powerAxis: 'p' }, { cells: '#000', labels: '#111' }, async () => null);
    expect(r.layers[0].mode).toBe('fill');
    expect(r.items.length).toBe(18);
    expect(r.items[7].override).toMatchObject({ power: 40, scanOffset: 0.1 });
    expect(r.items[0].paths!.length).toBe(4);
    expect(barPaths(7, 10)[1][0].x).toBeCloseTo(2);
  });
});
