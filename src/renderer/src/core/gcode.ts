import type { Bounds, Item, JobOptions, Layer, MachineProfile, Polyline, Pt } from './types';
import { anchorPoint, copyOffsets, isEmpty, itemsBounds, optimizeOrder, placedPaths } from './geometry';
import { rasterize, type Raster } from './raster';
import { kerfOffset } from './kerf';

const f = (n: number) => {
  const s = n.toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};

/** Objects that actually take part in a job: on an existing, enabled layer. */
export function activeItems(items: Item[], layers: Layer[]): Item[] {
  const on = new Set(layers.filter((l) => l.enabled).map((l) => l.id));
  return items.filter((i) => on.has(i.layerId));
}

/** Offset applied to the whole job, depending on the origin mode. */
export function jobOffset(items: Item[], opt: JobOptions): Pt {
  if (opt.originMode === 'absolute') return { x: 0, y: 0 };
  const b = itemsBounds(items);
  if (isEmpty(b)) return { x: 0, y: 0 };
  const a = anchorPoint(b, opt.anchor);
  return { x: opt.currentPos.x - a.x, y: opt.currentPos.y - a.y };
}

export function jobBounds(items: Item[], opt: JobOptions): Bounds {
  const b = itemsBounds(items);
  const o = jobOffset(items, opt);
  return { minX: b.minX + o.x, minY: b.minY + o.y, maxX: b.maxX + o.x, maxY: b.maxY + o.y };
}

/**
 * Work to run, in the user's layer order (top of the list runs first). Disabled layers are skipped.
 * Objects with their own speed/power override (e.g. material-test cells) form separate groups
 * that use the layer settings merged with the override.
 */
export function orderedWork(items: Item[], layers: Layer[]) {
  const out: { layer: Layer; items: Item[] }[] = [];
  for (const l of layers) {
    if (!l.enabled) continue;
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      if (it.layerId !== l.id) continue;
      const k = it.override ? JSON.stringify(it.override) : '';
      const g = groups.get(k);
      if (g) g.push(it);
      else groups.set(k, [it]);
    }
    for (const [k, its] of groups) out.push({ layer: k ? { ...l, ...its[0].override } : l, items: its });
  }
  return out;
}

export interface GcodeResult {
  lines: string[];
  bounds: Bounds;
  /** Every X/Y the head is commanded to (overscan, travel and the return move included) */
  motion: Bounds;
  /** Estimated run time (seconds), ignoring acceleration */
  seconds: number;
  /** Toolpaths for the preview (offset already applied) */
  preview: { cut: Polyline[]; travel: Polyline[] };
}

export function generateJob(
  items: Item[],
  layers: Layer[],
  m: MachineProfile,
  opt: JobOptions,
  /** Injectable for tests (the real rasterizer needs a browser canvas) */
  deps: { rasterize?: typeof rasterize } = {},
): GcodeResult {
  const raster = deps.rasterize ?? rasterize;
  // Objects on disabled layers neither run nor move the anchor point
  items = activeItems(items, layers);
  const off = jobOffset(items, opt);
  const out: string[] = [];
  const cut: Polyline[] = [];
  const travel: Polyline[] = [];
  let pos: Pt = opt.originMode === 'current' ? { ...opt.currentPos } : { x: 0, y: 0 };
  const startPos = { ...pos };
  let seconds = 0;
  const S = (layer: Layer, frac: number) => Math.round(Math.max(0, Math.min(1, frac)) * (layer.power / 100) * m.sMax);

  const g0 = (p: Pt) => {
    travel.push([pos, p]);
    seconds += (Math.hypot(p.x - pos.x, p.y - pos.y) / m.travelSpeed) * 60;
    out.push(`G0 X${f(p.x)} Y${f(p.y)}`);
    pos = p;
  };

  out.push('; CraftLover GRBL - G-code for GRBL 1.1 (laser mode $32=1)');
  out.push(`; Created ${new Date().toISOString()}`);
  out.push('G90 G21', 'G17', 'M5 S0');

  for (const { layer, items: its } of orderedWork(items, layers)) {
    out.push(`; ---- Layer ${layer.id} (${layer.mode}) speed ${layer.speed} mm/min, power ${layer.power}%, ${layer.passes} pass(es)`);
    // Air assist per layer (M8 on / M9 off) — only for machines that have it wired to coolant
    if (m.airAssist) out.push(layer.air ? 'M8' : 'M9');
    // M4 = dynamic power: GRBL lowers power when the head slows down in corners → more even lines
    out.push('M4 S0');
    for (let pass = 0; pass < Math.max(1, layer.passes); pass++) {
      if (layer.passes > 1) out.push(`; Pass ${pass + 1}/${layer.passes}`);
      if (layer.mode === 'line') {
        const all: Polyline[] = [];
        for (const it of its)
          for (const o of copyOffsets(it))
            // Kerf: grow part outlines / shrink holes by half the beam width (per object, so
            // holes are recognised inside their own part)
            for (const pl of kerfOffset(placedPaths(it, { x: o.x + off.x, y: o.y + off.y }), layer.kerf ?? 0)) all.push(pl);
        const s = S(layer, 1);
        let first = true;
        for (const pl of optimizeOrder(all, pos)) {
          g0(pl[0]);
          let line = `G1 X${f(pl[1].x)} Y${f(pl[1].y)} S${s}`;
          if (first) line += ` F${layer.speed}`;
          first = false;
          out.push(line);
          for (let k = 2; k < pl.length; k++) out.push(`G1 X${f(pl[k].x)} Y${f(pl[k].y)}`);
          for (let k = 1; k < pl.length; k++) seconds += (Math.hypot(pl[k].x - pl[k - 1].x, pl[k].y - pl[k - 1].y) / layer.speed) * 60;
          cut.push(pl);
          pos = pl[pl.length - 1];
        }
      } else {
        for (const it of its) {
          const r = raster(it, layer);
          for (const o of copyOffsets(it)) rasterGcode(r, { x: o.x + off.x, y: o.y + off.y }, layer);
        }
      }
    }
    out.push('M5 S0');
  }

  function rasterGcode(r: Raster, o: Pt, layer: Layer) {
    let dirLTR = true;
    let firstF = true;
    for (let row = r.rows - 1; row >= 0; row--) {
      // The bottom image row maps to the smallest Y
      const y = o.y + (r.rows - 1 - row + 0.5) * r.py;
      const base = row * r.cols;
      let a = -1;
      let b = -1;
      for (let c = 0; c < r.cols; c++)
        if (S(layer, r.data[base + c]) > 0) {
          if (a < 0) a = c;
          b = c;
        }
      if (a < 0) continue; // blank row → skip
      const xL = o.x + a * r.px;
      const xR = o.x + (b + 1) * r.px;
      const ltr = layer.bidirectional ? dirLTR : true;
      // Overscan is shortened at the bed edges so the head never travels past X = 0 / X = bed width
      const ovL = Math.max(0, Math.min(layer.overscan, xL));
      const ovR = Math.max(0, Math.min(layer.overscan, m.bedW - xR));
      g0({ x: ltr ? xL - ovL : xR + ovR, y });
      out.push(`G1 X${f(ltr ? xL : xR)} S0${firstF ? ` F${layer.speed}` : ''}`);
      firstF = false;
      const order = ltr ? range(a, b) : range(a, b).reverse();
      let curS = -1;
      let runEnd = 0;
      for (const c of order) {
        const s = S(layer, r.data[base + c]);
        const edge = ltr ? o.x + (c + 1) * r.px : o.x + c * r.px;
        if (s !== curS && curS >= 0) out.push(`G1 X${f(runEnd)} S${curS}`);
        curS = s;
        runEnd = edge;
      }
      out.push(`G1 X${f(runEnd)} S${curS}`);
      const endX = ltr ? xR + ovR : xL - ovL;
      out.push(`G1 X${f(endX)} S0`);
      cut.push([{ x: xL, y }, { x: xR, y }]);
      seconds += ((xR - xL + ovL + ovR) / layer.speed) * 60;
      pos = { x: endX, y };
      dirLTR = !dirLTR;
    }
  }

  out.push('M5 S0');
  if (m.airAssist) out.push('M9');
  g0(startPos);
  out.push('M2');
  return { lines: out, bounds: jobBounds(items, opt), motion: gcodeBounds(out), seconds, preview: { cut, travel } };
}

function range(a: number, b: number) {
  const r: number[] = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}

/**
 * Trace the job's bounding box at very low power (M3 = constant power) to position the material.
 * framePower = 0 → move the head only, laser off.
 */
export function frameGcode(items: Item[], m: MachineProfile, opt: JobOptions): string[] {
  const b = jobBounds(items, opt);
  if (isEmpty(b)) return [];
  const s = Math.round((m.framePower / 100) * m.sMax);
  const back = opt.originMode === 'current' ? opt.currentPos : null;
  const lines = [
    'G90 G21',
    `G0 X${f(b.minX)} Y${f(b.minY)}`,
    s > 0 ? `M3 S${s}` : 'M5 S0',
    `G1 X${f(b.maxX)} Y${f(b.minY)} F${m.frameSpeed}`,
    `G1 X${f(b.maxX)} Y${f(b.maxY)}`,
    `G1 X${f(b.minX)} Y${f(b.maxY)}`,
    `G1 X${f(b.minX)} Y${f(b.minY)}`,
    'M5 S0',
  ];
  if (back) lines.push(`G0 X${f(back.x)} Y${f(back.y)}`);
  return lines;
}

/**
 * Bounding box of every position the G-code moves to (absolute G90 coordinates).
 * Used to check the real toolpath against the machine travel, not just the design.
 */
export function gcodeBounds(lines: string[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let x: number | null = null;
  let y: number | null = null;
  for (const raw of lines) {
    const l = raw.replace(/;.*$/, '').toUpperCase();
    const mx = l.match(/X(-?[\d.]+)/);
    const my = l.match(/Y(-?[\d.]+)/);
    if (!mx && !my) continue;
    if (/\bG(10|92|53)\b/.test(l)) continue; // coordinate-system setup, not a move
    if (mx) x = parseFloat(mx[1]);
    if (my) y = parseFloat(my[1]);
    if (x !== null) {
      b.minX = Math.min(b.minX, x);
      b.maxX = Math.max(b.maxX, x);
    }
    if (y !== null) {
      b.minY = Math.min(b.minY, y);
      b.maxY = Math.max(b.maxY, y);
    }
  }
  return b;
}

/** True when the bounds stay inside the bed (0..bedW × 0..bedH), with a tiny tolerance. */
export function insideBed(b: Bounds, m: Pick<MachineProfile, 'bedW' | 'bedH'>, tol = 0.001): boolean {
  return b.minX >= -tol && b.minY >= -tol && b.maxX <= m.bedW + tol && b.maxY <= m.bedH + tol;
}
