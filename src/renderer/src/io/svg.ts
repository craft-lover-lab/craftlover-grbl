import type { Polyline } from '../core/types';
import { parsePathData } from './svgPath';
import { pathsBounds, isEmpty } from '../core/geometry';
import { t } from '../i18n';

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

/**
 * Đọc SVG và trả về các đường (mm, trục Y hướng lên, gốc tại góc dưới-trái khung bao).
 */
export function importSvg(text: string): { paths: Polyline[]; w: number; h: number } {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parsed = doc.querySelector('svg');
  if (!parsed || doc.querySelector('parsererror')) throw new Error(t('err.svgInvalid'));
  // Loại bỏ mọi nội dung có thể thực thi trước khi gắn vào trang
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
    const paths: Polyline[] = [];
    const walk = (el: Element, hidden: boolean) => {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const disp = el.getAttribute('display') === 'none' || (el as HTMLElement).style?.display === 'none';
      if (disp || hidden) return;
      const d = shapeToD(el);
      if (d) {
        const m = elementMatrix(el, svg);
        for (const pl of parsePathData(d, tolUnits))
          paths.push(
            pl.map((p) => ({
              x: (m[0] * p.x + m[2] * p.y + m[4] - vx) * sx,
              y: -(m[1] * p.x + m[3] * p.y + m[5] - vy) * sy, // lật trục Y
            })),
          );
      }
      for (const c of Array.from(el.children)) walk(c, false);
    };
    for (const c of Array.from(svg.children)) walk(c, false);
    const b = pathsBounds(paths);
    if (isEmpty(b)) throw new Error(t('err.svgEmpty'));
    const norm = paths.map((pl) => pl.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })));
    return { paths: norm, w: b.maxX - b.minX, h: b.maxY - b.minY };
  } finally {
    host.remove();
  }
}
