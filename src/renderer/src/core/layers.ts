import type { Layer } from './types';

/**
 * Before v0.2 the run order was fixed by mode (image → fill → line).
 * Layers are now run in list order, so older saved layer lists are re-sorted once
 * to keep producing exactly the same jobs.
 */
export function migrateLegacyOrder(layers: Layer[]): Layer[] {
  const rank = { image: 0, fill: 1, line: 2 } as const;
  return layers
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank[a.l.mode] - rank[b.l.mode] || a.i - b.i)
    .map(({ l }) => l);
}
