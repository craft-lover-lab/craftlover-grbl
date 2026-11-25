import type { MachineProfile } from './types';

/** One measured point: at this speed, shift each scan line back by this much (mm). */
export interface ScanOffsetPoint {
  speed: number;
  offset: number;
}

/** Keep only usable points, sorted by speed, one per speed. */
export function cleanScanOffsets(pts: ScanOffsetPoint[] | undefined): ScanOffsetPoint[] {
  const by = new Map<number, number>();
  for (const p of pts ?? []) {
    const speed = Math.round(p.speed);
    if (!(speed > 0) || !Number.isFinite(p.offset)) continue;
    by.set(speed, Math.min(1, Math.max(-1, p.offset)));
  }
  return [...by].map(([speed, offset]) => ({ speed, offset })).sort((a, b) => a.speed - b.speed);
}

/**
 * Scan offset (mm) for a speed, from the machine's measured table.
 * The beam lags behind the head by a roughly fixed time, so the offset grows with speed:
 * between two measured speeds it is interpolated, outside them it is scaled in proportion
 * to the speed (no table → 0).
 */
export function scanOffsetFor(m: Pick<MachineProfile, 'scanOffsets'>, speed: number): number {
  const pts = cleanScanOffsets(m.scanOffsets);
  if (!pts.length || !(speed > 0)) return 0;
  const lo = pts[0];
  const hi = pts[pts.length - 1];
  if (speed <= lo.speed) return (lo.offset * speed) / lo.speed;
  if (speed >= hi.speed) return (hi.offset * speed) / hi.speed;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (speed <= b.speed) return a.offset + ((b.offset - a.offset) * (speed - a.speed)) / (b.speed - a.speed);
  }
  return hi.offset;
}
