import ClipperLib from 'clipper-lib';
import type { Polyline } from './types';

/** Clipper works on integers: 1 unit = 1 µm. */
const SCALE = 1000;

export type BoolOp = 'union' | 'subtract' | 'intersect';

const isClosed = (pl: Polyline) => pl.length > 3 && Math.hypot(pl[0].x - pl[pl.length - 1].x, pl[0].y - pl[pl.length - 1].y) < 1e-6;

const toClip = (pl: Polyline): ClipperLib.Path => pl.slice(0, -1).map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromClip = (path: ClipperLib.Path): Polyline => {
  const pl = path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
  return pl.length ? [...pl, { ...pl[0] }] : pl;
};

function exec(type: ClipperLib.ClipType, subject: ClipperLib.Paths, clip: ClipperLib.Paths, fill: ClipperLib.PolyFillType) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out: ClipperLib.Paths = [];
  c.Execute(type, out, fill, fill);
  return out;
}

/**
 * One object's closed paths as a clean area: holes follow the even-odd rule, like the
 * fill engraving and the canvas (so the inside of an "O" stays a hole).
 */
function area(paths: Polyline[]): ClipperLib.Paths {
  const closed = paths.filter(isClosed).map(toClip);
  return closed.length ? exec(ClipperLib.ClipType.ctUnion, closed, [], ClipperLib.PolyFillType.pftEvenOdd) : [];
}

export interface BoolResult {
  paths: Polyline[];
  /** Objects that had open paths (lines), which have no area and were left out */
  openIgnored: number;
}

/**
 * Combine objects (each a list of paths in the same coordinates) into one shape:
 * - union: everything merged (overlapping outlines welded into one)
 * - subtract: the first object minus all the others
 * - intersect: only the area all objects share
 * Only closed paths take part; open lines are dropped and counted.
 */
export function booleanPaths(op: BoolOp, objects: Polyline[][]): BoolResult {
  const openIgnored = objects.filter((o) => o.some((pl) => pl.length > 1 && !isClosed(pl))).length;
  const areas = objects.map(area);
  const NZ = ClipperLib.PolyFillType.pftNonZero;
  let out: ClipperLib.Paths;
  if (op === 'union') out = exec(ClipperLib.ClipType.ctUnion, areas.flat(), [], NZ);
  else if (op === 'subtract') out = exec(ClipperLib.ClipType.ctDifference, areas[0] ?? [], areas.slice(1).flat(), NZ);
  else out = areas.slice(1).reduce((acc, a) => (acc.length ? exec(ClipperLib.ClipType.ctIntersection, acc, a, NZ) : acc), areas[0] ?? []);
  // Drop slivers left by rounding (under 0.0001 mm²)
  const paths = out.filter((p) => p.length > 2 && Math.abs(ClipperLib.Clipper.Area(p)) > 100).map(fromClip);
  return { paths, openIgnored };
}
