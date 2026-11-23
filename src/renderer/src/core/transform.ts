import type { Item } from './types';
import { pathsBounds } from './geometry';
import { grayToUrl } from '../io/image';

/**
 * Rotate (degrees, counter-clockwise) and/or flip an object around its center.
 * The transform is baked into the data, so everything else (bounds, engraving, cutting)
 * keeps working with axis-aligned rectangles.
 */
export function transformItem(item: Item, angleDeg: number, flipX = false, flipY = false): Item {
  const t = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;

  if (item.kind === 'vector' && item.paths) {
    const sx = item.w / item.srcW;
    const sy = item.h / item.srcH;
    const rot = item.paths.map((pl) =>
      pl.map((p) => {
        const x = (p.x * sx - item.w / 2) * fx;
        const y = (p.y * sy - item.h / 2) * fy;
        return { x: x * cos - y * sin, y: x * sin + y * cos };
      }),
    );
    const b = pathsBounds(rot);
    const paths = rot.map((pl) => pl.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })));
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    return { ...item, paths, srcW: w, srcH: h, w, h, x: cx - w / 2, y: cy - h / 2 };
  }

  if (item.kind === 'bitmap' && item.bitmap) {
    const bm = item.bitmap;
    // Resample to equal X/Y pixel density (the object may have been stretched)
    const pxPerMM = bm.width / item.w;
    const sw = bm.width;
    const sh = Math.max(1, Math.round(item.h * pxPerMM));
    const raw = document.createElement('canvas');
    raw.width = bm.width;
    raw.height = bm.height;
    const rctx = raw.getContext('2d')!;
    const img = rctx.createImageData(bm.width, bm.height);
    for (let j = 0, i = 0; j < bm.gray.length; j++, i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = bm.gray[j];
      img.data[i + 3] = 255;
    }
    rctx.putImageData(img, 0, 0);
    const src = document.createElement('canvas');
    src.width = sw;
    src.height = sh;
    src.getContext('2d')!.drawImage(raw, 0, 0, sw, sh);
    const W = Math.max(1, Math.round(Math.abs(sw * cos) + Math.abs(sh * sin)));
    const H = Math.max(1, Math.round(Math.abs(sw * sin) + Math.abs(sh * cos)));
    const dst = document.createElement('canvas');
    dst.width = W;
    dst.height = H;
    const ctx = dst.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-t); // canvas Y axis points down
    ctx.scale(fx, fy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -sw / 2, -sh / 2);
    const data = ctx.getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let j = 0, i = 0; j < gray.length; j++, i += 4) gray[j] = data[i];
    const w = W / pxPerMM;
    const h = H / pxPerMM;
    return {
      ...item,
      bitmap: { width: W, height: H, gray, url: grayToUrl(gray, W, H) },
      srcW: w,
      srcH: h,
      w,
      h,
      x: cx - w / 2,
      y: cy - h / 2,
    };
  }
  return item;
}
