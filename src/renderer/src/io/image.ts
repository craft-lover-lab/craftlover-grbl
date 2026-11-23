import type { Bitmap } from '../core/types';
import { pdfPageVectors, type PdfPageVector } from './pdfVector';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

/** Convert a canvas to grayscale (transparent pixels count as white). */
export function canvasToBitmap(canvas: HTMLCanvasElement): Bitmap {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    const a = data[i + 3] / 255;
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[j] = Math.round(l * a + 255 * (1 - a));
  }
  return { width, height, gray, url: grayToUrl(gray, width, height) };
}

export function grayToUrl(gray: Uint8Array, width: number, height: number): string {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let j = 0, i = 0; j < gray.length; j++, i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = gray[j];
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Pixel cap so very large images do not freeze the app. */
const MAX_PIXELS = 4000 * 4000;

export async function importRaster(data: Uint8Array, mime: string): Promise<{ bitmap: Bitmap; w: number; h: number }> {
  const blob = new Blob([data as BlobPart], { type: mime });
  const img = await createImageBitmap(blob);
  let { width, height } = img;
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  width = Math.round(width * k);
  height = Math.round(height * k);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d')!.drawImage(img, 0, 0, width, height);
  img.close();
  // Default 254 DPI (10 dots/mm); scale down if larger than 150 mm
  let w = width / 10;
  let h = height / 10;
  const s = Math.min(1, 150 / Math.max(w, h));
  return { bitmap: canvasToBitmap(c), w: w * s, h: h * s };
}

export interface PdfPage {
  /** Vector paths for cutting/scoring (may be empty) */
  vector: PdfPageVector;
  /** 300 DPI render of the page — only created when it has text/images or no vector paths */
  raster: { bitmap: Bitmap; w: number; h: number } | null;
}

/** Read PDF/AI: extract vector paths, plus a rendered image when the page has text or images. */
export async function importPdf(data: Uint8Array): Promise<PdfPage[]> {
  const task = pdfjs.getDocument({ data: data.slice() });
  const doc = await task.promise;
  const out: PdfPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vector = await pdfPageVectors(page);
      let raster: PdfPage['raster'] = null;
      if (vector.paths.length === 0 || vector.hasText || vector.hasImage) {
        const base = page.getViewport({ scale: 1 }); // units: pt
        let scale = 300 / 72;
        if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas: c } as any).promise;
        raster = { bitmap: canvasToBitmap(c), w: (base.width * 25.4) / 72, h: (base.height * 25.4) / 72 };
      }
      out.push({ vector, raster });
    }
  } finally {
    await task.destroy();
  }
  return out;
}
