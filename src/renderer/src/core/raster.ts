import type { Item, Layer } from './types';

export interface Raster {
  cols: number;
  rows: number;
  /** Power level 0..1 (fraction of the layer power); row 0 is the TOP row */
  data: Float32Array;
  /** Size of one dot in X/Y (mm) */
  px: number;
  py: number;
}

const cache = new Map<string, Raster>();

function key(item: Item, layer: Layer) {
  return [item.id, item.w, item.h, item.srcW, item.srcH, layer.lineInterval, layer.dither, layer.threshold, layer.minPower, layer.power, layer.mode, item.bitmap?.url.length, item.paths?.length].join('|');
}

/** Sample an object into a dot grid at the layer's line interval. */
export function rasterize(item: Item, layer: Layer): Raster {
  const k = key(item, layer);
  const hit = cache.get(k);
  if (hit) return hit;
  const iv = Math.max(0.02, layer.lineInterval);
  const cols = Math.max(1, Math.round(item.w / iv));
  const rows = Math.max(1, Math.round(item.h / iv));
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cols, rows);

  if (item.kind === 'bitmap' && item.bitmap) {
    const src = document.createElement('canvas');
    src.width = item.bitmap.width;
    src.height = item.bitmap.height;
    const sctx = src.getContext('2d')!;
    const img = sctx.createImageData(src.width, src.height);
    const g = item.bitmap.gray;
    for (let j = 0, i = 0; j < g.length; j++, i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g[j];
      img.data[i + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cols, rows);
  } else if (item.paths) {
    // Fill vectors with the even-odd rule (holes inside letters stay open)
    const sx = cols / item.srcW;
    const sy = rows / item.srcH;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const pl of item.paths) {
      pl.forEach((p, i) => {
        const x = p.x * sx;
        const y = rows - p.y * sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }

  const rgba = ctx.getImageData(0, 0, cols, rows).data;
  const g = new Float32Array(cols * rows);
  for (let j = 0, i = 0; j < g.length; j++, i += 4) g[j] = rgba[i] / 255; // 0 = black, 1 = white
  const data = new Float32Array(cols * rows);
  const mode = layer.mode === 'fill' ? 'threshold' : layer.dither;
  const minF = Math.min(1, layer.minPower / Math.max(1, layer.power));

  if (mode === 'threshold') {
    const th = layer.mode === 'fill' ? 0.5 : layer.threshold / 255;
    for (let j = 0; j < g.length; j++) data[j] = g[j] < th ? 1 : 0;
  } else if (mode === 'floyd') {
    const buf = Float32Array.from(g);
    for (let y = 0; y < rows; y++) {
      // Serpentine scan to reduce directional artefacts
      const ltr = y % 2 === 0;
      for (let n = 0; n < cols; n++) {
        const x = ltr ? n : cols - 1 - n;
        const j = y * cols + x;
        const old = buf[j];
        const v = old < 0.5 ? 0 : 1;
        data[j] = v === 0 ? 1 : 0;
        const err = old - v;
        const dx = ltr ? 1 : -1;
        if (x + dx >= 0 && x + dx < cols) buf[j + dx] += (err * 7) / 16;
        if (y + 1 < rows) {
          if (x - dx >= 0 && x - dx < cols) buf[j + cols - dx] += (err * 3) / 16;
          buf[j + cols] += (err * 5) / 16;
          if (x + dx >= 0 && x + dx < cols) buf[j + cols + dx] += (err * 1) / 16;
        }
      }
    }
  } else {
    // Grayscale: power follows darkness; near-white dots turn the laser off
    for (let j = 0; j < g.length; j++) {
      const dark = 1 - g[j];
      data[j] = dark < 0.02 ? 0 : minF + (1 - minF) * dark;
    }
  }
  const r: Raster = { cols, rows, data, px: item.w / cols, py: item.h / rows };
  if (cache.size > 30) cache.clear();
  cache.set(k, r);
  return r;
}
