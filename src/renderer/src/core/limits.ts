import type { Bounds, Pt } from './types';

export interface TravelProblem {
  axis: 'X' | 'Y';
  /** Requested range in machine coordinates */
  lo: number;
  hi: number;
  /** Allowed machine range */
  min: number;
  max: number;
}

/**
 * Check a toolpath against the machine's physical travel, in MACHINE coordinates
 * (work coordinates + WCO). Only meaningful after homing, when machine zero is a real,
 * repeatable reference.
 *
 * GRBL's machine space is [-travel, 0] by default, or [0, travel] on builds that force the
 * origin to the home position. The current machine position tells which one applies
 * (a position away from 0 can only lie inside one of them); right at home both are possible,
 * and the toolpath must then fit inside at least one.
 */
export function checkMachineTravel(motion: Bounds, wco: Pt, mpos: Pt, travel: { x: number; y: number }, tol = 0.5): TravelProblem | null {
  const axes = [
    { axis: 'X' as const, lo: motion.minX + wco.x, hi: motion.maxX + wco.x, pos: mpos.x, t: travel.x },
    { axis: 'Y' as const, lo: motion.minY + wco.y, hi: motion.maxY + wco.y, pos: mpos.y, t: travel.y },
  ];
  for (const a of axes) {
    const spaces: [number, number][] = [];
    if (a.pos <= tol) spaces.push([-a.t, 0]);
    if (a.pos >= -tol) spaces.push([0, a.t]);
    const fits = spaces.some(([min, max]) => a.lo >= min - tol && a.hi <= max + tol);
    if (!fits) {
      const [min, max] = spaces[0];
      return { axis: a.axis, lo: a.lo, hi: a.hi, min, max };
    }
  }
  return null;
}
