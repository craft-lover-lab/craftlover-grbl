import { describe, expect, it } from 'vitest';
import { checkMachineTravel } from '../src/renderer/src/core/limits';
import { createRasterCache, type Raster } from '../src/renderer/src/core/raster';
import { activeItems, frameGcode, gcodeBounds, generateJob } from '../src/renderer/src/core/gcode';
import { rectPath } from '../src/renderer/src/core/shapes';
import type { Item, JobOptions, Layer, MachineProfile } from '../src/renderer/src/core/types';

const travel = { x: 410, y: 400 };
const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

describe('machine travel check (machine coordinates)', () => {
  it('accepts a job inside the default negative machine space', () => {
    // Work origin at machine (-400, -390): work 0..100 → machine -400..-300
    expect(checkMachineTravel(box(0, 0, 100, 100), { x: -400, y: -390 }, { x: -350, y: -350 }, travel)).toBeNull();
  });

  it('rejects a job that runs past machine zero even though work coordinates look fine', () => {
    // Work origin set near the end of travel: work 0..100 → machine -50..+50
    const p = checkMachineTravel(box(0, 0, 100, 100), { x: -50, y: -390 }, { x: -50, y: -390 }, travel);
    expect(p).toMatchObject({ axis: 'X', min: -410, max: 0 });
  });

  it('supports controllers with a positive machine space', () => {
    expect(checkMachineTravel(box(0, 0, 100, 100), { x: 10, y: 10 }, { x: 50, y: 50 }, travel)).toBeNull();
    expect(checkMachineTravel(box(0, 0, 100, 100), { x: 350, y: 10 }, { x: 360, y: 50 }, travel)).toMatchObject({ axis: 'X', min: 0, max: 410 });
  });

  it('at the home position, accepts the job if it fits either machine space', () => {
    expect(checkMachineTravel(box(-300, -300, -10, -10), { x: 0, y: 0 }, { x: 0, y: 0 }, travel)).toBeNull();
    expect(checkMachineTravel(box(-300, -300, 50, -10), { x: 0, y: 0 }, { x: 0, y: 0 }, travel)).not.toBeNull();
  });
});

describe('raster cache', () => {
  const layer: Layer = {
    id: 'f', name: 'Fill', color: '#000', mode: 'fill', speed: 3000, power: 40, minPower: 0, passes: 1,
    lineInterval: 0.1, dither: 'floyd', threshold: 128, overscan: 2.5, bidirectional: true, enabled: true,
  };
  // An L shape: rotating it 180° keeps size and path count but changes the raster
  const L = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]];
  const item: Item = { id: 'a', name: 'L', kind: 'vector', paths: L, srcW: 10, srcH: 10, w: 10, h: 10, x: 0, y: 0, layerId: 'f', copies: { cols: 1, rows: 1, gapX: 0, gapY: 0 } };

  it('reuses the raster for unchanged geometry and resamples after a rotation', () => {
    let calls = 0;
    const r = createRasterCache((): Raster => (calls++, { cols: 1, rows: 1, data: new Float32Array(1), px: 1, py: 1 }));
    r(item, layer);
    r({ ...item, x: 50 }, layer); // moved only: same geometry
    expect(calls).toBe(1);
    const rotated = { ...item, paths: L.map((pl) => pl.map((p) => ({ x: 10 - p.x, y: 10 - p.y }))) };
    r(rotated, layer);
    expect(calls).toBe(2);
    r(item, { ...layer, lineInterval: 0.2 }); // different settings
    expect(calls).toBe(3);
  });
});

describe('only participating objects count', () => {
  const machine: MachineProfile = { name: 'S30', laser: '10W', bedW: 410, bedH: 400, sMax: 1000, baud: 115200, frameSpeed: 3000, framePower: 0, travelSpeed: 6000 };
  const base = { minPower: 0, passes: 1, lineInterval: 0.1, dither: 'floyd' as const, threshold: 128, overscan: 2.5, bidirectional: true };
  const on: Layer = { ...base, id: 'on', name: 'On', color: '#f00', mode: 'line', speed: 300, power: 100, enabled: true };
  const off: Layer = { ...base, id: 'off', name: 'Off', color: '#00f', mode: 'line', speed: 300, power: 100, enabled: false };
  const sq = (x: number, layerId: string): Item => ({ id: `${x}${layerId}`, name: 's', kind: 'vector', paths: [rectPath(10, 10)], srcW: 10, srcH: 10, w: 10, h: 10, x, y: 10, layerId, copies: { cols: 1, rows: 1, gapX: 0, gapY: 0 } });
  const items = [sq(10, 'on'), sq(300, 'off')];

  it('frames only objects on enabled layers', () => {
    const b = gcodeBounds(frameGcode(activeItems(items, [on, off]), machine, { originMode: 'absolute', anchor: 'bl', currentPos: { x: 0, y: 0 } }));
    expect(b.maxX).toBe(20);
  });

  it('anchors "current position" jobs on enabled objects only', () => {
    const cur: JobOptions = { originMode: 'current', anchor: 'bl', currentPos: { x: 100, y: 100 } };
    const j = generateJob(items, [on, off], machine, cur);
    expect(j.bounds).toEqual({ minX: 100, minY: 100, maxX: 110, maxY: 110 });
  });
});
