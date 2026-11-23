import type { Item, Layer } from '../core/types';
import { grayToUrl } from './image';
import { t } from '../i18n';

const VERSION = 1;

function toB64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

/** Save a project (.lzr) as JSON: objects and layers; images are embedded as base64. */
export function serializeProject(items: Item[], layers: Layer[]): string {
  return JSON.stringify({
    app: 'laser-tool',
    version: VERSION,
    layers,
    items: items.map((it) => ({
      ...it,
      bitmap: it.bitmap ? { width: it.bitmap.width, height: it.bitmap.height, gray: toB64(it.bitmap.gray) } : undefined,
    })),
  });
}

export function parseProject(text: string): { items: Item[]; layers: Layer[] } {
  const d = JSON.parse(text);
  if (d.app !== 'laser-tool' || !Array.isArray(d.items) || !Array.isArray(d.layers)) throw new Error(t('err.notProject'));
  const items: Item[] = d.items.map((it: any) => {
    if (!it.bitmap) return it;
    const gray = fromB64(it.bitmap.gray);
    if (gray.length !== it.bitmap.width * it.bitmap.height) throw new Error(t('err.imageBroken', { name: it.name }));
    return { ...it, bitmap: { width: it.bitmap.width, height: it.bitmap.height, gray, url: grayToUrl(gray, it.bitmap.width, it.bitmap.height) } };
  });
  return { items, layers: d.layers };
}
