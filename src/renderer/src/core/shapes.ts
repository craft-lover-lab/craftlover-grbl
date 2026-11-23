import type { Polyline, Pt, ShapeSpec } from './types';

/** Số đoạn thẳng xấp xỉ cho một cung tròn bán kính r (mm), sai số ~0.02 mm. */
function arcSegs(r: number, sweep: number) {
  if (r <= 0) return 1;
  const step = 2 * Math.acos(Math.max(-1, 1 - 0.02 / r));
  return Math.max(4, Math.min(720, Math.ceil(sweep / (step || 0.1))));
}

/** Hình chữ nhật w×h (góc dưới-trái tại 0,0), bo góc bán kính r. */
export function rectPath(w: number, h: number, r = 0): Polyline {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 0.01)
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
      { x: 0, y: 0 },
    ];
  const pts: Pt[] = [];
  const corners: [number, number, number][] = [
    [w - r, r, -Math.PI / 2],
    [w - r, h - r, 0],
    [r, h - r, Math.PI / 2],
    [r, r, Math.PI],
  ];
  const n = arcSegs(r, Math.PI / 2);
  for (const [cx, cy, a0] of corners)
    for (let k = 0; k <= n; k++) {
      const a = a0 + (k / n) * (Math.PI / 2);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  pts.push({ ...pts[0] });
  return pts;
}

export function ellipsePath(w: number, h: number): Polyline {
  const n = arcSegs(Math.max(w, h) / 2, Math.PI * 2);
  const pts: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2;
    pts.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) });
  }
  pts[n] = { ...pts[0] };
  return pts;
}

/** Đa giác đều nội tiếp elip w×h, một đỉnh hướng lên trên. */
export function polygonPath(sides: number, w: number, h: number): Polyline {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  const raw: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const a = Math.PI / 2 + (k / n) * Math.PI * 2;
    raw.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  // Co giãn khung bao của đa giác cho vừa đúng w×h
  const minX = Math.min(...raw.map((p) => p.x));
  const maxX = Math.max(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const maxY = Math.max(...raw.map((p) => p.y));
  const pts = raw.map((p) => ({ x: ((p.x - minX) / (maxX - minX)) * w, y: ((p.y - minY) / (maxY - minY)) * h }));
  pts.push({ ...pts[0] });
  return pts;
}

/** Tạo lại đường của hình theo kích thước hiện tại (dùng khi đổi bo góc / số cạnh). */
export function shapePaths(s: ShapeSpec, w: number, h: number): Polyline[] | null {
  switch (s.type) {
    case 'rect':
      return [rectPath(w, h, s.radius ?? 0)];
    case 'ellipse':
      return [ellipsePath(w, h)];
    case 'polygon':
      return [polygonPath(s.sides ?? 6, w, h)];
  }
  return null;
}

/** Khung bao của đa giác đều bán kính R (đỉnh hướng lên), và vị trí tâm trong khung đó. */
export function regularPolygonBox(sides: number, R: number) {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    const a = Math.PI / 2 + (k / n) * Math.PI * 2;
    const x = R * Math.cos(a);
    const y = R * Math.sin(a);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { w: maxX - minX, h: maxY - minY, cx: -minX, cy: -minY };
}
