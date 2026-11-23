import opentype from 'opentype.js';
import type { Polyline, Pt } from '../core/types';
import { cubic, quad } from './svgPath';
import { pathsBounds, isEmpty } from '../core/geometry';
import { t } from '../i18n';

const fontCache = new Map<string, opentype.Font>();

async function loadFont(file: string) {
  let f = fontCache.get(file);
  if (!f) {
    const data = await window.laser.readFont(file);
    f = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    fontCache.set(file, f);
  }
  return f;
}

export type TextAlign = 'left' | 'center' | 'right';

/**
 * Chuyển chữ thành đường vector theo font đã cài trên máy.
 * size = cỡ chữ (mm, chiều cao em), lineHeight tính theo bội số của size.
 */
export async function textToPaths(text: string, fontFile: string, size: number, align: TextAlign = 'left', lineHeight = 1.2) {
  const font = await loadFont(fontFile);
  const lines = text.split(/\r?\n/);
  const widths = lines.map((l) => font.getAdvanceWidth(l, size));
  const maxW = Math.max(...widths, 0);
  const out: Polyline[] = [];
  lines.forEach((line, li) => {
    const x0 = align === 'center' ? (maxW - widths[li]) / 2 : align === 'right' ? maxW - widths[li] : 0;
    const path = font.getPath(line, x0, li * size * lineHeight, size);
    let cur: Polyline = [];
    let p: Pt = { x: 0, y: 0 };
    let start: Pt = p;
    const flush = () => {
      if (cur.length > 1) out.push(cur);
      cur = [];
    };
    // Font dùng trục Y hướng xuống → lật lại cho trục máy
    const P = (x: number, y: number): Pt => ({ x, y: -y });
    for (const c of path.commands as any[]) {
      switch (c.type) {
        case 'M':
          flush();
          p = start = P(c.x, c.y);
          cur = [p];
          break;
        case 'L':
          p = P(c.x, c.y);
          cur.push(p);
          break;
        case 'C': {
          const e = P(c.x, c.y);
          cur.push(...cubic(p, P(c.x1, c.y1), P(c.x2, c.y2), e, 0.02));
          p = e;
          break;
        }
        case 'Q': {
          const e = P(c.x, c.y);
          cur.push(...quad(p, P(c.x1, c.y1), e, 0.02));
          p = e;
          break;
        }
        case 'Z':
          if (cur.length) cur.push({ ...start });
          flush();
          p = start;
          break;
      }
    }
    flush();
  });
  const b = pathsBounds(out);
  if (isEmpty(b)) throw new Error(t('err.fontNoGlyphs'));
  return {
    paths: out.map((pl) => pl.map((q) => ({ x: q.x - b.minX, y: q.y - b.minY }))),
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
  };
}
