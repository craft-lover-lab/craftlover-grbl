import type { Bounds, Item, JobOptions, Layer, MachineProfile, Polyline, Pt } from './types';
import { anchorPoint, copyOffsets, isEmpty, itemsBounds, optimizeOrder, placedPaths } from './geometry';
import { rasterize } from './raster';

const f = (n: number) => {
  const s = n.toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};

/** Độ dời áp vào toàn bộ lệnh, tùy theo chế độ gốc tọa độ. */
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

/** Danh sách đối tượng sẽ chạy: chỉ lớp đang bật; khắc ảnh/tô trước, cắt sau cùng. */
function orderedWork(items: Item[], layers: Layer[]) {
  const rank = { image: 0, fill: 1, line: 2 } as const;
  return layers
    .filter((l) => l.enabled)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank[a.l.mode] - rank[b.l.mode] || a.i - b.i)
    .map(({ l }) => ({ layer: l, items: items.filter((it) => it.layerId === l.id) }))
    .filter((w) => w.items.length > 0);
}

export interface GcodeResult {
  lines: string[];
  bounds: Bounds;
  /** Ước lượng thời gian chạy (giây), chưa tính gia tốc */
  seconds: number;
  /** Đường di chuyển để xem trước (đã cộng độ dời) */
  preview: { cut: Polyline[]; travel: Polyline[] };
}

export function generateJob(items: Item[], layers: Layer[], m: MachineProfile, opt: JobOptions): GcodeResult {
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

  out.push('; Laser Tool — G-code cho GRBL 1.1 (chế độ laser $32=1)');
  out.push(`; Tạo lúc ${new Date().toLocaleString('vi-VN')}`);
  out.push('G90 G21', 'G17', 'M5 S0');

  for (const { layer, items: its } of orderedWork(items, layers)) {
    out.push(`; ---- Lớp "${layer.name}" (${layer.mode}) tốc độ ${layer.speed} mm/ph, công suất ${layer.power}% x${layer.passes} lượt`);
    // M4 = công suất động: GRBL tự giảm công suất khi đầu laser chạy chậm ở góc → nét đều hơn
    out.push('M4 S0');
    for (let pass = 0; pass < Math.max(1, layer.passes); pass++) {
      if (layer.passes > 1) out.push(`; Lượt ${pass + 1}/${layer.passes}`);
      if (layer.mode === 'line') {
        const all: Polyline[] = [];
        for (const it of its)
          for (const o of copyOffsets(it))
            for (const pl of placedPaths(it, { x: o.x + off.x, y: o.y + off.y })) all.push(pl);
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
          const r = rasterize(it, layer);
          for (const o of copyOffsets(it)) rasterGcode(r, { x: o.x + off.x, y: o.y + off.y }, layer);
        }
      }
    }
    out.push('M5 S0');
  }

  function rasterGcode(r: ReturnType<typeof rasterize>, o: Pt, layer: Layer) {
    let dirLTR = true;
    let firstF = true;
    for (let row = r.rows - 1; row >= 0; row--) {
      // Hàng ảnh dưới cùng ứng với Y nhỏ nhất
      const y = o.y + (r.rows - 1 - row + 0.5) * r.py;
      const base = row * r.cols;
      let a = -1;
      let b = -1;
      for (let c = 0; c < r.cols; c++)
        if (S(layer, r.data[base + c]) > 0) {
          if (a < 0) a = c;
          b = c;
        }
      if (a < 0) continue; // hàng trắng → bỏ qua
      const xL = o.x + a * r.px;
      const xR = o.x + (b + 1) * r.px;
      const ltr = layer.bidirectional ? dirLTR : true;
      const ov = layer.overscan;
      g0({ x: ltr ? xL - ov : xR + ov, y });
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
      const endX = ltr ? xR + ov : xL - ov;
      out.push(`G1 X${f(endX)} S0`);
      cut.push([{ x: xL, y }, { x: xR, y }]);
      seconds += ((xR - xL + 2 * ov) / layer.speed) * 60;
      pos = { x: endX, y };
      dirLTR = !dirLTR;
    }
  }

  out.push('M5 S0');
  g0(startPos);
  out.push('M2');
  return { lines: out, bounds: jobBounds(items, opt), seconds, preview: { cut, travel } };
}

function range(a: number, b: number) {
  const r: number[] = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}

/**
 * Chạy khung bao vùng cắt với công suất rất thấp (M3 = công suất cố định) để căn phôi.
 * framePower = 0 → chỉ di chuyển đầu laser, không bật tia.
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
