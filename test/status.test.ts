import { describe, expect, it } from 'vitest';
import { parseStatus } from '../src/renderer/src/machine/useGrbl';

describe('status report: air assist (accessory field)', () => {
  const wco = { x: 0, y: 0 };
  it('is unknown until GRBL reports overrides', () => {
    expect(parseStatus('<Idle|MPos:0.000,0.000,0.000|FS:0,0>', wco).air).toBeUndefined();
  });
  it('A:F (flood, M8) means on; A:M (mist, M7) too', () => {
    expect(parseStatus('<Run|MPos:1,2,0|FS:300,1000|Ov:100,100,100|A:SF>', wco).air).toBe(true);
    expect(parseStatus('<Run|MPos:1,2,0|FS:300,1000|A:M>', wco).air).toBe(true);
  });
  it('Ov without A: nothing is on', () => {
    expect(parseStatus('<Idle|MPos:0,0,0|FS:0,0|Ov:100,100,100>', wco, true).air).toBe(false);
  });
  it('A:S alone (spindle only) is off', () => {
    expect(parseStatus('<Run|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:S>', wco, true).air).toBe(false);
  });
  it('keeps the last known state between override reports', () => {
    expect(parseStatus('<Run|MPos:0,0,0|FS:0,0>', wco, true).air).toBe(true);
    expect(parseStatus('<Run|MPos:0,0,0|FS:0,0>', wco, false).air).toBe(false);
  });
});
