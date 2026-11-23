import * as pdfjs from 'pdfjs-dist';
import type { Polyline, Pt } from '../core/types';
import { cubic, quad } from './svgPath';
import { pathsBounds, isEmpty } from '../core/geometry';

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const ap = (m: M, x: number, y: number): Pt => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** Mã lệnh vẽ đường bên trong constructPath của pdf.js (DrawOPS) */
const D = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const PT_MM = 25.4 / 72;

export interface PdfPageVector {
  paths: Polyline[];
  w: number;
  h: number;
  /** Trang có chữ hoặc ảnh (không chuyển được thành đường cắt) */
  hasText: boolean;
  hasImage: boolean;
}

/** Trích đường vector từ một trang PDF (mm, trục Y hướng lên, chuẩn hóa về góc dưới-trái). */
export async function pdfPageVectors(page: pdfjs.PDFPageProxy): Promise<PdfPageVector> {
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS as Record<string, number>;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const out: Polyline[] = [];
  let hasText = false;
  let hasImage = false;
  const tol = 0.1; // pt

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as any[];
    switch (fn) {
      case O.save:
        stack.push(ctm);
        break;
      case O.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case O.transform:
        ctm = mul(ctm, args as unknown as M);
        break;
      case O.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) ctm = mul(ctm, Array.from(args[0] as number[]) as M);
        break;
      case O.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case O.showText:
      case O.showSpacedText:
      case O.nextLineShowText:
      case O.nextLineSetSpacingShowText:
        hasText = true;
        break;
      case O.paintImageXObject:
      case O.paintInlineImageXObject:
      case O.paintImageXObjectRepeat:
      case O.paintImageMaskXObject:
        hasImage = true;
        break;
      case O.constructPath: {
        const paintOp = args[0];
        if (paintOp === O.endPath) break; // đường cắt xén (clip), không vẽ
        const data = args[1]?.[0] as ArrayLike<number> | null;
        if (!data) break;
        let cur: Polyline = [];
        let p: Pt = { x: 0, y: 0 };
        let start: Pt = p;
        const flush = () => {
          if (cur.length > 1) out.push(cur);
          cur = [];
        };
        for (let k = 0; k < data.length; ) {
          switch (data[k++]) {
            case D.moveTo:
              flush();
              p = start = ap(ctm, data[k++], data[k++]);
              cur = [p];
              break;
            case D.lineTo:
              p = ap(ctm, data[k++], data[k++]);
              if (!cur.length) cur.push(start);
              cur.push(p);
              break;
            case D.curveTo: {
              const c1 = ap(ctm, data[k++], data[k++]);
              const c2 = ap(ctm, data[k++], data[k++]);
              const e = ap(ctm, data[k++], data[k++]);
              if (!cur.length) cur.push(p);
              cur.push(...cubic(p, c1, c2, e, tol));
              p = e;
              break;
            }
            case D.quadraticCurveTo: {
              const c = ap(ctm, data[k++], data[k++]);
              const e = ap(ctm, data[k++], data[k++]);
              if (!cur.length) cur.push(p);
              cur.push(...quad(p, c, e, tol));
              p = e;
              break;
            }
            case D.closePath:
              if (cur.length) cur.push({ ...start });
              flush();
              p = start;
              break;
            default:
              k = data.length; // định dạng lạ → bỏ qua đường này
          }
        }
        flush();
        break;
      }
    }
  }
  const b = pathsBounds(out);
  if (isEmpty(b)) return { paths: [], w: 0, h: 0, hasText, hasImage };
  const paths = out.map((pl) => pl.map((q) => ({ x: (q.x - b.minX) * PT_MM, y: (q.y - b.minY) * PT_MM })));
  return { paths, w: (b.maxX - b.minX) * PT_MM, h: (b.maxY - b.minY) * PT_MM, hasText, hasImage };
}
