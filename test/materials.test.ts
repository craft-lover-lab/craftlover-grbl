import { describe, expect, it } from 'vitest';
import { builtinPresets, matchesMachine, mergePresets, normalizePresets, presetFromLayer, presetToLayer } from '../src/renderer/src/core/materials';
import { buildTestGrid, DEFAULT_TEST, steps } from '../src/renderer/src/core/testGrid';
import type { Layer } from '../src/renderer/src/core/types';

const layer: Layer = {
  id: 'cut', name: 'Cut', color: '#f00', mode: 'line', speed: 300, power: 100, minPower: 0, passes: 2,
  lineInterval: 0.1, dither: 'floyd', threshold: 128, overscan: 2.5, bidirectional: true, enabled: true,
};

describe('material library', () => {
  it('round-trips a layer through a preset', () => {
    const p = presetFromLayer(layer, { machine: 'S30', laser: '10W' });
    expect(presetToLayer(p)).toMatchObject({ mode: 'line', speed: 300, power: 100, passes: 2 });
  });

  it('normalizes imported data and clamps bad values', () => {
    const [p] = normalizePresets({ presets: [{ material: 'Wood', speed: -5, power: 250, passes: 0, mode: 'weird' }] });
    expect(p).toMatchObject({ material: 'Wood', speed: 1, power: 100, passes: 1, mode: 'line' });
    expect(p.id).toBeTruthy();
  });

  it('rejects files that are not a library', () => {
    expect(() => normalizePresets({ hello: 1 })).toThrow('LIBRARY_INVALID');
  });

  it('merges by id', () => {
    const cur = builtinPresets();
    const r = mergePresets(cur, [{ ...cur[0], power: 1 }, { ...cur[0], id: 'new' }]);
    expect(r).toMatchObject({ added: 1, updated: 1 });
    expect(r.presets.find((p) => p.id === cur[0].id)!.power).toBe(1);
  });

  it('filters by machine and laser, case-insensitively', () => {
    const p = builtinPresets()[0];
    expect(matchesMachine(p, 'sculpfun s30', '10W DIODE')).toBe(true);
    expect(matchesMachine(p, 'xTool D1', '10W diode')).toBe(false);
  });
});

describe('test grid', () => {
  it('spreads values evenly and rounds them', () => {
    expect(steps(1000, 6000, 5, 10)).toEqual([1000, 2250, 3500, 4750, 6000]);
    expect(steps(20, 100, 1, 1)).toEqual([20]);
  });

  it('creates one cell per combination with its own override', async () => {
    const r = await buildTestGrid(
      { ...DEFAULT_TEST, cols: 4, rows: 3, labels: false },
      { cells: 'c', labels: 'l', cell: () => 'x', speedAxis: 's', powerAxis: 'p' },
      { cells: '#000', labels: '#111' },
      async () => null,
    );
    expect(r.items).toHaveLength(12);
    expect(new Set(r.items.map((i) => `${i.override!.speed}/${i.override!.power}`)).size).toBe(12);
    expect(r.layers).toHaveLength(2);
  });
});
