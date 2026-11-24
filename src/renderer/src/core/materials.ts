import type { Layer, MaterialPreset } from './types';
import { uid } from './geometry';

/** Layer fields that a material preset stores and applies. */
const SETTINGS = ['mode', 'speed', 'power', 'minPower', 'passes', 'lineInterval', 'dither', 'threshold', 'overscan', 'bidirectional', 'air', 'kerf'] as const;

const ENGRAVE = { minPower: 0, lineInterval: 0.1, dither: 'floyd' as const, threshold: 128, overscan: 2.5, bidirectional: true };

/**
 * Starting points for a Sculpfun S30 10W diode (same values as the README table).
 * They are only a first guess: wood, glue and moisture vary, so users should run a test grid.
 */
export function builtinPresets(): MaterialPreset[] {
  const base = { machine: 'Sculpfun S30', laser: '10W diode', notes: 'Starting point — run a test grid on your own material first.', ...ENGRAVE };
  const p = (material: string, thickness: number, operation: string, mode: MaterialPreset['mode'], speed: number, power: number, passes = 1): MaterialPreset => ({
    ...base,
    // Cuts are cleaner and safer with air assist; kerf stays 0 until measured on your machine
    air: operation === 'Cut',
    kerf: 0,
    id: `builtin-${material}-${thickness}-${operation}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-'),
    material,
    thickness,
    operation,
    mode,
    speed,
    power,
    passes,
  });
  return [
    p('Plywood', 3, 'Cut', 'line', 350, 100),
    p('Plywood', 5, 'Cut', 'line', 275, 100, 3),
    p('MDF', 3, 'Cut', 'line', 300, 100),
    p('Cardboard', 2, 'Cut', 'line', 1200, 80),
    p('Plywood', 3, 'Score', 'line', 3000, 30),
    p('Plywood', 3, 'Fill engrave', 'fill', 5000, 40),
    p('Plywood', 3, 'Photo engrave', 'image', 3000, 50),
    p('Leather', 2, 'Fill engrave', 'fill', 6000, 20),
    p('Paper', 0.2, 'Cut', 'line', 2000, 30),
    p('Acrylic (black)', 3, 'Fill engrave', 'fill', 3000, 30),
  ];
}

/** Settings to copy from a preset into a layer. */
export function presetToLayer(p: MaterialPreset): Partial<Layer> {
  const out: Partial<Layer> = {};
  for (const k of SETTINGS) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

/** A new preset pre-filled from a layer's current settings. */
export function presetFromLayer(l: Layer, meta: { machine: string; laser: string }): MaterialPreset {
  const out = { id: uid(), machine: meta.machine, laser: meta.laser, material: '', thickness: 3, operation: l.name, notes: '' } as MaterialPreset;
  for (const k of SETTINGS) (out as unknown as Record<string, unknown>)[k] = l[k];
  return out;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

/** Validate and normalize presets read from disk or an imported file. Invalid entries are dropped. */
export function normalizePresets(data: unknown): MaterialPreset[] {
  const arr = Array.isArray(data) ? data : Array.isArray((data as { presets?: unknown })?.presets) ? (data as { presets: unknown[] }).presets : null;
  if (!arr) throw new Error('LIBRARY_INVALID');
  const modes = ['line', 'fill', 'image'];
  const dithers = ['floyd', 'threshold', 'grayscale'];
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      id: str(x.id) || uid(),
      machine: str(x.machine),
      laser: str(x.laser),
      material: str(x.material),
      thickness: num(x.thickness, 0),
      operation: str(x.operation),
      mode: (modes.includes(x.mode as string) ? x.mode : 'line') as MaterialPreset['mode'],
      speed: Math.max(1, num(x.speed, 1000)),
      power: Math.min(100, Math.max(0, num(x.power, 20))),
      minPower: Math.min(100, Math.max(0, num(x.minPower, 0))),
      passes: Math.max(1, Math.round(num(x.passes, 1))),
      lineInterval: Math.max(0.03, num(x.lineInterval, 0.1)),
      dither: (dithers.includes(x.dither as string) ? x.dither : 'floyd') as MaterialPreset['dither'],
      threshold: Math.min(254, Math.max(1, num(x.threshold, 128))),
      overscan: Math.max(0, num(x.overscan, 2.5)),
      bidirectional: x.bidirectional !== false,
      air: x.air === true,
      kerf: Math.min(2, Math.max(0, num(x.kerf, 0))),
      notes: str(x.notes),
    }))
    .filter((p) => p.material || p.operation);
}

/** Merge imported presets: entries with the same id are replaced, new ones are appended. */
export function mergePresets(current: MaterialPreset[], incoming: MaterialPreset[]) {
  const byId = new Map(current.map((p) => [p.id, p]));
  let added = 0;
  let updated = 0;
  for (const p of incoming) {
    if (byId.has(p.id)) updated++;
    else added++;
    byId.set(p.id, p);
  }
  return { presets: [...byId.values()], added, updated };
}

/** Case-insensitive match of machine + laser (empty fields match anything). */
export function matchesMachine(p: MaterialPreset, machine: string, laser: string) {
  const eq = (a: string, b: string) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();
  return eq(p.machine, machine) && eq(p.laser, laser);
}
