import type { Polyline, Pt } from '../core/types';

/** Phân tích chuỗi "d" của SVG path thành các đường gấp khúc (đơn vị người dùng SVG). */
export function parsePathData(d: string, tol = 0.1): Polyline[] {
  const tokens = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
  const out: Polyline[] = [];
  let cur: Polyline = [];
  let i = 0;
  let cmd = '';
  let p: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let lastCtrl: Pt | null = null;
  let lastCmd = '';

  const isCmd = (t: string) => /^[a-z]$/i.test(t);
  const num = () => parseFloat(tokens[i++]);
  const flag = () => {
    // Cờ của lệnh A có thể viết dính liền: "a1 1 0 0110 10"
    const t = tokens[i];
    if (t.length > 1 && (t[0] === '0' || t[0] === '1') && !t.includes('.')) {
      tokens[i] = t.slice(1);
      return t[0] === '1';
    }
    i++;
    return parseFloat(t) !== 0;
  };
  const flush = () => {
    if (cur.length > 1) out.push(cur);
    cur = [];
  };
  const lineTo = (q: Pt) => {
    if (cur.length === 0) cur.push(p);
    cur.push(q);
    p = q;
  };

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? p.x : 0;
    const oy = rel ? p.y : 0;
    let ctrl: Pt | null = null;
    switch (C) {
      case 'M': {
        flush();
        p = { x: ox + num(), y: oy + num() };
        start = p;
        cur = [p];
        cmd = rel ? 'l' : 'L'; // các cặp số tiếp theo là lệnh L
        break;
      }
      case 'L':
        lineTo({ x: ox + num(), y: oy + num() });
        break;
      case 'H':
        lineTo({ x: ox + num(), y: p.y });
        break;
      case 'V':
        lineTo({ x: p.x, y: oy + num() });
        break;
      case 'Z':
        if (cur.length) {
          lineTo({ ...start });
          flush();
        }
        p = start;
        break;
      case 'C': {
        const c1 = { x: ox + num(), y: oy + num() };
        const c2 = { x: ox + num(), y: oy + num() };
        const e = { x: ox + num(), y: oy + num() };
        cubic(p, c1, c2, e, tol).forEach(lineTo);
        ctrl = c2;
        break;
      }
      case 'S': {
        const c1: Pt = lastCtrl && /[CS]/.test(lastCmd) ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y } : p;
        const c2 = { x: ox + num(), y: oy + num() };
        const e = { x: ox + num(), y: oy + num() };
        cubic(p, c1, c2, e, tol).forEach(lineTo);
        ctrl = c2;
        break;
      }
      case 'Q': {
        const c = { x: ox + num(), y: oy + num() };
        const e = { x: ox + num(), y: oy + num() };
        quad(p, c, e, tol).forEach(lineTo);
        ctrl = c;
        break;
      }
      case 'T': {
        const c: Pt = lastCtrl && /[QT]/.test(lastCmd) ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y } : p;
        const e = { x: ox + num(), y: oy + num() };
        quad(p, c, e, tol).forEach(lineTo);
        ctrl = c;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const e = { x: ox + num(), y: oy + num() };
        arc(p, rx, ry, rot, large, sweep, e, tol).forEach(lineTo);
        break;
      }
      default:
        i++;
    }
    lastCtrl = ctrl;
    lastCmd = C;
    if (tokens.length && i > tokens.length) break;
  }
  flush();
  return out.filter((pl) => pl.every((q) => isFinite(q.x) && isFinite(q.y)));
}

function segs(len: number, tol: number) {
  return Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-6)))));
}

export function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number): Pt[] {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const n = segs(len, tol);
  const pts: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

export function quad(p0: Pt, p1: Pt, p2: Pt, tol: number): Pt[] {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const n = segs(len, tol);
  const pts: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    pts.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
  return pts;
}

/** Cung elip SVG (chuyển từ dạng điểm đầu/cuối sang dạng tâm, theo phụ lục F.6 của đặc tả SVG). */
function arc(p0: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, p1: Pt, tol: number): Pt[] {
  if (rx === 0 || ry === 0) return [p1];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = segs(Math.abs(dt) * Math.max(rx, ry), tol);
  const pts: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    pts.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy });
  }
  pts[pts.length - 1] = p1;
  return pts;
}
