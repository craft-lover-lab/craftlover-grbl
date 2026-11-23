import { useEffect, useRef, useState } from 'react';
import type { Bounds, Item, Layer, Polyline, Pt } from '../core/types';
import { copyOffsets, isEmpty, itemBounds, placedPaths } from '../core/geometry';

interface Props {
  bedW: number;
  bedH: number;
  items: Item[];
  layers: Layer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Item>) => void;
  laserPos: Pt | null;
  jobFrame: Bounds | null;
  preview: { cut: Polyline[]; travel: Polyline[] } | null;
}

const imgCache = new Map<string, HTMLImageElement>();
function getImg(url: string, redraw: () => void) {
  let im = imgCache.get(url);
  if (!im) {
    im = new Image();
    im.onload = redraw;
    im.src = url;
    imgCache.set(url, im);
  }
  return im;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'move'; id: string; start: Pt; ix: number; iy: number }
  | { kind: 'resize'; id: string; start: Pt; w: number; h: number; ratio: number };

export function Workspace(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ scale: 1.5, ox: 40, oy: 40 }); // ox/oy: vị trí màn hình của gốc (0,0) tính từ góc dưới-trái
  const drag = useRef<Drag | null>(null);
  const [tick, setTick] = useState(0);
  const userMoved = useRef(false);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(100, r.width), h: Math.max(100, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (userMoved.current || size.w < 200) return;
    const s = Math.min((size.w - 60) / p.bedW, (size.h - 60) / p.bedH);
    setView({ scale: s, ox: (size.w - p.bedW * s) / 2, oy: (size.h - p.bedH * s) / 2 });
  }, [size, p.bedW, p.bedH]);

  // mm → màn hình
  const toS = (x: number, y: number) => [view.ox + x * view.scale, size.h - (view.oy + y * view.scale)] as const;
  const toMM = (sx: number, sy: number): Pt => ({ x: (sx - view.ox) / view.scale, y: (size.h - sy - view.oy) / view.scale });

  useEffect(() => {
    const c = cv.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#15171b';
    ctx.fillRect(0, 0, size.w, size.h);

    // Bàn máy & lưới
    const [bx0, by0] = toS(0, 0);
    const [bx1, by1] = toS(p.bedW, p.bedH);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(bx0, by1, bx1 - bx0, by0 - by1);
    ctx.lineWidth = 1;
    for (let g = 0; g <= Math.max(p.bedW, p.bedH); g += 10) {
      ctx.strokeStyle = g % 50 === 0 ? '#cfc9bd' : '#e6e1d6';
      if (g <= p.bedW) {
        const [x] = toS(g, 0);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, by0);
        ctx.lineTo(x + 0.5, by1);
        ctx.stroke();
      }
      if (g <= p.bedH) {
        const [, y] = toS(0, g);
        ctx.beginPath();
        ctx.moveTo(bx0, y + 0.5);
        ctx.lineTo(bx1, y + 0.5);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#8b93a1';
    ctx.font = '11px system-ui';
    for (let g = 0; g <= p.bedW; g += 50) {
      const [x] = toS(g, 0);
      ctx.fillText(String(g), x + 2, by0 + 13);
    }
    for (let g = 50; g <= p.bedH; g += 50) {
      const [, y] = toS(0, g);
      ctx.fillText(String(g), bx0 - 26, y + 4);
    }

    // Đối tượng
    const layerOf = (id: string) => p.layers.find((l) => l.id === id);
    for (const it of p.items) {
      const layer = layerOf(it.layerId);
      const color = layer?.color ?? '#000';
      const dim = layer && !layer.enabled;
      ctx.globalAlpha = dim ? 0.25 : 1;
      for (const o of copyOffsets(it)) {
        if (it.kind === 'bitmap' && it.bitmap) {
          const im = getImg(it.bitmap.url, () => setTick((t) => t + 1));
          const [x, y] = toS(o.x, o.y + it.h);
          if (im.complete) ctx.drawImage(im, x, y, it.w * view.scale, it.h * view.scale);
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2;
          if (layer?.mode === 'fill') ctx.fillStyle = color + '55';
          ctx.beginPath();
          for (const pl of placedPaths(it, o))
            pl.forEach((q, i) => {
              const [x, y] = toS(q.x, q.y);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
          if (layer?.mode === 'fill') ctx.fill('evenodd');
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Xem trước đường chạy
    if (p.preview) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(80,110,160,.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const pl of p.preview.travel)
        pl.forEach((q, i) => {
          const [x, y] = toS(q.x, q.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(220,40,40,.45)';
      ctx.beginPath();
      for (const pl of p.preview.cut)
        pl.forEach((q, i) => {
          const [x, y] = toS(q.x, q.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      ctx.stroke();
    }

    // Vùng chọn
    const sel = p.items.find((i) => i.id === p.selectedId);
    if (sel) {
      const b = itemBounds(sel);
      const [x0, y0] = toS(b.minX, b.maxY);
      const [x1, y1] = toS(b.maxX, b.minY);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#2f7cf6';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      const [hx, hy] = toS(sel.x + sel.w, sel.y + sel.h);
      ctx.fillStyle = '#2f7cf6';
      ctx.fillRect(hx - 5, hy - 5, 10, 10);
      ctx.fillStyle = '#2f7cf6';
      ctx.fillText(`${sel.w.toFixed(1)} × ${sel.h.toFixed(1)} mm`, x0, y0 - 6);
    }

    // Khung công việc (khi chạy theo vị trí hiện tại)
    if (p.jobFrame && !isEmpty(p.jobFrame)) {
      const b = p.jobFrame;
      const [x0, y0] = toS(b.minX, b.maxY);
      const [x1, y1] = toS(b.maxX, b.minY);
      ctx.setLineDash([8, 4]);
      ctx.strokeStyle = '#f08a24';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }

    // Gốc làm việc & vị trí đầu laser
    const [zx, zy] = toS(0, 0);
    ctx.strokeStyle = '#18a058';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(zx, zy);
    ctx.lineTo(zx + 24, zy);
    ctx.moveTo(zx, zy);
    ctx.lineTo(zx, zy - 24);
    ctx.stroke();
    if (p.laserPos) {
      const [lx, ly] = toS(p.laserPos.x, p.laserPos.y);
      ctx.strokeStyle = '#e5243b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(lx, ly, 7, 0, Math.PI * 2);
      ctx.moveTo(lx - 12, ly);
      ctx.lineTo(lx + 12, ly);
      ctx.moveTo(lx, ly - 12);
      ctx.lineTo(lx, ly + 12);
      ctx.stroke();
    }
  }, [p, view, size, tick]);

  const hit = (m: Pt) => {
    for (let i = p.items.length - 1; i >= 0; i--) {
      const b = itemBounds(p.items[i]);
      if (m.x >= b.minX && m.x <= b.maxX && m.y >= b.minY && m.y <= b.maxY) return p.items[i];
    }
    return null;
  };

  const onDown = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const m = toMM(sx, sy);
    const sel = p.items.find((i) => i.id === p.selectedId);
    if (e.button === 0 && sel) {
      const [hx, hy] = toS(sel.x + sel.w, sel.y + sel.h);
      if (Math.abs(sx - hx) < 8 && Math.abs(sy - hy) < 8) {
        drag.current = { kind: 'resize', id: sel.id, start: m, w: sel.w, h: sel.h, ratio: sel.h / sel.w };
        return;
      }
    }
    const h = e.button === 0 ? hit(m) : null;
    if (h) {
      p.onSelect(h.id);
      drag.current = { kind: 'move', id: h.id, start: m, ix: h.x, iy: h.y };
    } else {
      if (e.button === 0) p.onSelect(null);
      drag.current = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy };
    }
  };

  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = cv.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (d.kind === 'pan') (userMoved.current = true), setView((v) => ({ ...v, ox: d.ox + (sx - d.sx), oy: d.oy - (sy - d.sy) }));
    else {
      const m = toMM(sx, sy);
      if (d.kind === 'move') {
        let x = d.ix + m.x - d.start.x;
        let y = d.iy + m.y - d.start.y;
        if (!e.altKey) {
          // Bắt dính lưới 0.5 mm
          x = Math.round(x * 2) / 2;
          y = Math.round(y * 2) / 2;
        }
        p.onChange(d.id, { x, y });
      } else {
        const w = Math.max(1, d.w + m.x - d.start.x);
        p.onChange(d.id, { w, h: e.shiftKey ? Math.max(1, d.h + m.y - d.start.y) : w * d.ratio });
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const m = toMM(sx, sy);
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    userMoved.current = true;
    const scale = Math.min(60, Math.max(0.3, view.scale * k));
    setView({ scale, ox: sx - m.x * scale, oy: size.h - sy - m.y * scale });
  };

  return (
    <div ref={wrap} className="workspace">
      <canvas
        ref={cv}
        style={{ width: size.w, height: size.h }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="ws-hint">Lăn chuột: phóng to · Kéo nền: di chuyển · Kéo ô vuông xanh: đổi cỡ (Shift: tự do) · Alt: tắt bắt dính</div>
    </div>
  );
}
