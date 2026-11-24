import ClipperLib from 'clipper-lib';
import type { Polyline, Pt } from './types';

/** Clipper works on integers: 1 unit = 1 µm. */
const SCALE = 1000;

const isClosed = (pl: Polyline) => pl.length > 3 && Math.hypot(pl[0].x - pl[pl.length - 1].x, pl[0].y - pl[pl.length - 1].y) < 1e-6;

function insidePoly(p: Pt, poly: Polyline) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Kerf compensation: the beam removes `kerf` mm of material centred on the path,
 * so parts come out kerf/2 too small on every side and holes kerf/2 too big.
 *
 * Closed paths are offset by kerf/2 — outwards for part outlines and inwards for holes.
 * Which is which follows the even-odd rule: a path inside an even number of other closed
 * paths is an outline, inside an odd number it is a hole (so an island inside a hole is an
 * outline again). Open paths (score lines) are left unchanged. Sharp corners are kept with
 * mitred joins so parts that must fit together stay square.
 *
 * A hole too small to shrink would disappear; it is then cut unchanged.
 */
export function kerfOffset(paths: Polyline[], kerf: number): Polyline[] {
  if (!(kerf > 0)) return paths;
  const closed = paths.filter(isClosed);
  const out: Polyline[] = [];
  for (const pl of paths) {
    if (!isClosed(pl)) {
      out.push(pl);
      continue;
    }
    // Nesting depth decides outline vs hole; test with a vertex of this path
    const probe = pl[0];
    const depth = closed.filter((o) => o !== pl && insidePoly(probe, o)).length;
    const delta = (depth % 2 === 0 ? 1 : -1) * (kerf / 2);
    const ring = pl.slice(0, -1).map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
    // Clipper expands positively oriented polygons for a positive delta
    if (!ClipperLib.Clipper.Orientation(ring)) ring.reverse();
    const co = new ClipperLib.ClipperOffset(3, 0.25 * SCALE * 0.01);
    co.AddPath(ring, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    const solution: { X: number; Y: number }[][] = [];
    co.Execute(solution, delta * SCALE);
    if (!solution.length) {
      out.push(pl); // vanished (hole narrower than the kerf): keep the original cut
      continue;
    }
    for (const r of solution) {
      const pts = r.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }));
      pts.push({ ...pts[0] });
      out.push(pts);
    }
  }
  return out;
}

/**
 * Kerf from a test cut: cut a square of known size without compensation and measure it.
 * The part shrinks by one full kerf (kerf/2 per side).
 */
export function kerfFromMeasurement(nominal: number, measuredPart: number): number {
  return Math.max(0, nominal - measuredPart);
}
