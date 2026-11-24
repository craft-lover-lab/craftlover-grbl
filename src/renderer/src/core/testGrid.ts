import type { Item, Layer, LayerMode, Polyline } from './types';
import { uid } from './geometry';
import { rectPath } from './shapes';

export interface TestGridOptions {
  /** Cells are outlines (line) or filled squares (fill) */
  mode: Extract<LayerMode, 'line' | 'fill'>;
  speedMin: number;
  speedMax: number;
  /** Number of speed steps (columns) */
  cols: number;
  powerMin: number;
  powerMax: number;
  /** Number of power steps (rows) */
  rows: number;
  /** Cell size and gap (mm) */
  cell: number;
  gap: number;
  passes: number;
  /** Engrave the speed/power values next to the grid */
  labels: boolean;
  labelSpeed: number;
  labelPower: number;
  /** Bottom-left corner of the whole test (mm) */
  x: number;
  y: number;
}

export const DEFAULT_TEST: TestGridOptions = {
  mode: 'fill',
  speedMin: 1000,
  speedMax: 6000,
  cols: 5,
  powerMin: 20,
  powerMax: 100,
  rows: 5,
  cell: 10,
  gap: 3,
  passes: 1,
  labels: true,
  labelSpeed: 3000,
  labelPower: 20,
  x: 10,
  y: 10,
};

/** Evenly spaced, rounded values from min to max. */
export function steps(min: number, max: number, n: number, round: number): number[] {
  if (n <= 1) return [Math.round(min / round) * round];
  return Array.from({ length: n }, (_, i) => Math.round((min + ((max - min) * i) / (n - 1)) / round) * round);
}

/** Text renderer injected by the caller (keeps this module free of font loading). */
export type TextFn = (text: string, size: number) => Promise<{ paths: Polyline[]; w: number; h: number } | null>;

export interface TestGridResult {
  layers: Layer[];
  items: Item[];
  speeds: number[];
  powers: number[];
}

const COPIES_1 = { cols: 1, rows: 1, gapX: 5, gapY: 5 };

/**
 * Build a speed × power test: one square per combination, each with its own
 * speed/power override, plus optional value labels on a separate low-power layer.
 * Columns = speed (increasing to the right), rows = power (increasing upwards).
 */
export async function buildTestGrid(
  o: TestGridOptions,
  names: { cells: string; labels: string; cell: (s: number, p: number) => string; speedAxis: string; powerAxis: string },
  colors: { cells: string; labels: string },
  text: TextFn,
): Promise<TestGridResult> {
  const speeds = steps(o.speedMin, o.speedMax, Math.max(1, o.cols), 10);
  const powers = steps(o.powerMin, o.powerMax, Math.max(1, o.rows), 1);
  const base = { minPower: 0, lineInterval: 0.1, dither: 'floyd' as const, threshold: 128, overscan: 2.5, bidirectional: true, enabled: true };
  const cellLayer: Layer = { ...base, id: uid(), name: names.cells, color: colors.cells, mode: o.mode, speed: speeds[0], power: powers[0], passes: o.passes, air: o.mode === 'line' };
  const labelLayer: Layer = { ...base, id: uid(), name: names.labels, color: colors.labels, mode: 'line', speed: o.labelSpeed, power: o.labelPower, passes: 1 };

  const labelSize = Math.min(4, Math.max(2, o.cell * 0.3));
  // Leave room on the left for the power labels when labels are on
  const left = o.labels ? labelSize * 4 : 0;
  const pitch = o.cell + o.gap;
  const items: Item[] = [];

  powers.forEach((pw, r) =>
    speeds.forEach((sp, c) =>
      items.push({
        id: uid(),
        name: names.cell(sp, pw),
        kind: 'vector',
        shape: { type: 'rect', radius: 0 },
        paths: [rectPath(o.cell, o.cell)],
        srcW: o.cell,
        srcH: o.cell,
        w: o.cell,
        h: o.cell,
        x: o.x + left + c * pitch,
        y: o.y + r * pitch,
        layerId: cellLayer.id,
        copies: COPIES_1,
        override: { speed: sp, power: pw, passes: o.passes },
      }),
    ),
  );

  if (o.labels) {
    const addText = async (s: string, size: number, at: (w: number, h: number) => { x: number; y: number }) => {
      const t = await text(s, size);
      if (!t) return;
      const p = at(t.w, t.h);
      items.push({ id: uid(), name: s, kind: 'vector', paths: t.paths, srcW: t.w, srcH: t.h, w: t.w, h: t.h, x: p.x, y: p.y, layerId: labelLayer.id, copies: COPIES_1 });
    };
    const top = o.y + powers.length * pitch - o.gap;
    // Speed values above each column, centered
    for (const [c, sp] of speeds.entries())
      await addText(String(sp), labelSize, (w) => ({ x: o.x + left + c * pitch + (o.cell - w) / 2, y: top + labelSize * 0.6 }));
    // Power values left of each row, right-aligned against the grid
    for (const [r, pw] of powers.entries())
      await addText(`${pw}%`, labelSize, (w, h) => ({ x: o.x + left - w - labelSize * 0.6, y: o.y + r * pitch + (o.cell - h) / 2 }));
    // Axis titles
    await addText(names.speedAxis, labelSize, () => ({ x: o.x + left, y: top + labelSize * 2.4 }));
    await addText(names.powerAxis, labelSize, (w) => ({ x: o.x + left - w - labelSize * 0.6, y: top + labelSize * 0.6 }));
  }
  return { layers: [cellLayer, labelLayer], items, speeds, powers };
}
