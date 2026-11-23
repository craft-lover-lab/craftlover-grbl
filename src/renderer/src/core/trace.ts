import type { Bitmap, Polyline, Pt } from './types';

/** Resolution cap for tracing so large images stay fast. */
const MAX_SIDE = 1500;

export interface TraceOptions {
  /** Pixels darker than this are treated as black (0..255) */
  threshold: number;
  /** Drop specks smaller than this area (mm²) */
  minArea: number;
  /** Maximum deviation when simplifying paths (in pixels) */
  smooth: number;
}

/**
 * Trace a black-and-white image into closed paths (mm, Y axis up).
 * Method: collect every pixel edge between black and white, chain them into loops,
 * then simplify with the Ramer–Douglas–Peucker algorithm.
 */
export function traceBitmap(bmp: Bitmap, wMM: number, hMM: number, opt: TraceOptions): Polyline[] {
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * k));
  const H = Math.max(1, Math.round(bmp.height * k));
  const black = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = Math.min(bmp.width - 1, Math.floor(x / k));
      const sy = Math.min(bmp.height - 1, Math.floor(y / k));
      black[y * W + x] = bmp.gray[sy * bmp.width + sx] < opt.threshold ? 1 : 0;
    }
  const B = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && black[y * W + x] === 1;

  // Directed edges: walking along an edge, black is always on the same side
  const V = W + 1;
  const next = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const a = y0 * V + x0;
    const list = next.get(a);
    if (list) list.push(y1 * V + x1);
    else next.set(a, [y1 * V + x1]);
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!B(x, y)) continue;
      if (!B(x, y - 1)) add(x + 1, y, x, y);
      if (!B(x, y + 1)) add(x, y + 1, x + 1, y + 1);
      if (!B(x - 1, y)) add(x, y, x, y + 1);
      if (!B(x + 1, y)) add(x + 1, y + 1, x + 1, y);
    }

  const loops: Pt[][] = [];
  for (const [startKey, outs] of next) {
    while (outs.length) {
      const loop: Pt[] = [];
      let cur = startKey;
      let guard = 0;
      do {
        loop.push({ x: cur % V, y: Math.floor(cur / V) });
        const o = next.get(cur);
        if (!o || !o.length) break;
        cur = o.pop()!;
      } while (cur !== startKey && ++guard < 4_000_000);
      if (loop.length > 2) {
        loop.push({ ...loop[0] });
        loops.push(loop);
      }
    }
  }

  const sx = wMM / W;
  const sy = hMM / H;
  const minAreaPx = opt.minArea / (sx * sy);
  const out: Polyline[] = [];
  for (const loop of loops) {
    if (Math.abs(area(loop)) < minAreaPx) continue;
    const simple = rdp(dropCollinear(loop), opt.smooth);
    if (simple.length < 4) continue;
    out.push(simple.map((p) => ({ x: p.x * sx, y: (H - p.y) * sy })));
  }
  return out;
}

function area(pts: Pt[]) {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  return a / 2;
}

function dropCollinear(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Ramer–Douglas–Peucker; closed loops are split at the point farthest from the start to keep their shape. */
function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 4 || eps <= 0) return pts;
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > fd) (fd = d), (far = i);
  }
  const a = simplify(pts.slice(0, far + 1), eps);
  const b = simplify(pts.slice(far), eps);
  return [...a.slice(0, -1), ...b];
}

function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const A = pts[s];
    const Bp = pts[e];
    const dx = Bp.x - A.x;
    const dy = Bp.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    let best = -1;
    let bd = 0;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * pts[i].x - dx * pts[i].y + Bp.x * A.y - Bp.y * A.x) / len;
      if (d > bd) (bd = d), (best = i);
    }
    if (best > 0 && bd > eps) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
