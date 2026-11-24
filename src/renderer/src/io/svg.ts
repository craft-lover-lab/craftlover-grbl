import type { Polyline } from '../core/types';
import { parsePathData } from './svgPath';
import { pathsBounds, isEmpty } from '../core/geometry';
import { t } from '../i18n';
import { paintsOf } from './svgColor';

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function lengthMM(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)$/i);
  if (!m || m[2] === '%') return null;
  const f = UNIT_MM[m[2].toLowerCase()];
  return f === undefined ? null : parseFloat(m[1]) * f;
}

const SKIP = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'title', 'desc', 'metadata', 'style', 'script', 'text']);

function shapeToD(el: Element): string | null {
  const n = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0;
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d');
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (w <= 0 || h <= 0) return null;
      let rx = el.hasAttribute('rx') ? n('rx') : n('ry');
      let ry = el.hasAttribute('ry') ? n('ry') : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = el.tagName.toLowerCase() === 'circle' ? n('r') : n('rx');
      const ry = el.tagName.toLowerCase() === 'circle' ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
    }
    case 'line':
      return `M${n('x1')},${n('y1')}L${n('x2')},${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '').trim();
      if (!pts) return null;
      return `M${pts}${el.tagName.toLowerCase() === 'polygon' ? 'Z' : ''}`;
    }
  }
  return null;
}

type M = [number, number, number, number, number, number]; // a b c d e f

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function elementMatrix(el: Element, root: Element): M {
  let m: M = [1, 0, 0, 1, 0, 0];
  for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
    const t = (e as SVGGraphicsElement).transform?.baseVal?.consolidate();
    if (t) {
      const k = t.matrix;
      m = mul([k.a, k.b, k.c, k.d, k.e, k.f], m);
    }
  }
  return m;
}

export interface SvgColorGroup {
  /** Original color, "#rrggbb" */
  color: string;
  /** Strokes → line (cut/score); fills → fill engrave (a shape with both in different colors is in two groups) */
  mode: 'line' | 'fill';
  /** Paths relative to the group's own bottom-left corner (mm) */
  paths: Polyline[];
  /** Position of the group inside the whole drawing (mm, from its bottom-left) */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Read an SVG and split it by color: every distinct stroke color (or fill color for
 * shapes without a stroke) becomes its own group, so it can go onto its own layer.
 * Colors come from the computed style, so CSS classes, inherited group styles and
 * currentColor all count. Sizes are in mm with the Y axis up.
 */
export function importSvg(text: string): { w: number; h: number; groups: SvgColorGroup[] } {
  const host = document.createElement('div');
  // Off-screen rather than visibility:hidden — the elements' own visibility is read from their style
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parsed = doc.querySelector('svg');
  if (!parsed || doc.querySelector('parsererror')) throw new Error(t('err.svgInvalid'));
  // Strip anything executable before attaching it to the page
  parsed.querySelectorAll('script, foreignObject, image, iframe').forEach((e) => e.remove());
  [parsed, ...Array.from(parsed.querySelectorAll('*'))].forEach((e) => {
    for (const a of Array.from(e.attributes)) if (a.name.toLowerCase().startsWith('on')) e.removeAttribute(a.name);
  });
  host.appendChild(document.importNode(parsed, true));
  document.body.appendChild(host);
  try {
    const svg = host.querySelector('svg')!;
    const vb = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    const wMM = lengthMM(svg.getAttribute('width'));
    const hMM = lengthMM(svg.getAttribute('height'));
    let sx = 25.4 / 96, sy = 25.4 / 96, vx = 0, vy = 0;
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      [vx, vy] = vb;
      if (wMM) sx = wMM / vb[2];
      if (hMM) sy = hMM / vb[3];
      if (wMM && !hMM) sy = sx;
      if (hMM && !wMM) sx = sy;
    }
    const tolUnits = 0.05 / Math.min(sx, sy);
    // key "color|mode" → paths, in first-seen order
    const byPaint = new Map<string, Polyline[]>();
    const walk = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return; // hides the whole subtree
      const d = shapeToD(el);
      const style = { stroke: cs.stroke, fill: cs.fill, strokeWidth: cs.strokeWidth, strokeOpacity: cs.strokeOpacity, fillOpacity: cs.fillOpacity, opacity: cs.opacity };
      const paints = d && cs.visibility !== 'hidden' ? paintsOf(style, tag !== 'line') : [];
      if (d && paints.length) {
        const m = elementMatrix(el, svg);
        const placed = parsePathData(d, tolUnits).map((pl) =>
          pl.map((p) => ({
            x: (m[0] * p.x + m[2] * p.y + m[4] - vx) * sx,
            y: -(m[1] * p.x + m[3] * p.y + m[5] - vy) * sy, // flip the Y axis
          })),
        );
        // Stroke and fill in different colors: the same outline goes to both groups
        for (const paint of paints) {
          const key = `${paint.color}|${paint.mode}`;
          if (!byPaint.has(key)) byPaint.set(key, []);
          byPaint.get(key)!.push(...placed);
        }
      }
      for (const c of Array.from(el.children)) walk(c);
    };
    for (const c of Array.from(svg.children)) walk(c);

    const all = pathsBounds([...byPaint.values()].flat());
    if (isEmpty(all)) throw new Error(t('err.svgEmpty'));
    const groups: SvgColorGroup[] = [];
    for (const [key, paths] of byPaint) {
      if (!paths.length) continue;
      const [color, mode] = key.split('|') as [string, 'line' | 'fill'];
      const b = pathsBounds(paths);
      groups.push({
        color,
        mode,
        paths: paths.map((pl) => pl.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }))),
        x: b.minX - all.minX,
        y: b.minY - all.minY,
        w: b.maxX - b.minX,
        h: b.maxY - b.minY,
      });
    }
    return { w: all.maxX - all.minX, h: all.maxY - all.minY, groups };
  } finally {
    host.remove();
  }
}
