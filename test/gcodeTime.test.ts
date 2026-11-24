import { describe, expect, it } from 'vitest';
import { estimateLineTimes, jobTiming, progressPlan } from '../src/renderer/src/core/gcodeTime';

describe('time estimate', () => {
  it('uses the travel speed for G0 and the modal feed for G1', () => {
    const t = estimateLineTimes(['G90 G21', 'G0 X60', 'G1 X120 F600', 'G1 Y60', '; comment', 'M5'], 6000);
    expect(t[1]).toBeCloseTo(0.6, 6); // 60 mm at 6000 mm/min
    expect(t[2]).toBeCloseTo(6, 6); // 60 mm at 600 mm/min
    expect(t[3]).toBeCloseTo(6, 6); // feed stays modal
    expect(t[4]).toBe(0);
    expect(t[5]).toBe(0);
  });

  it('indexes cumulative time by acknowledged (sent) lines, skipping comments', () => {
    const plan = progressPlan(['; header', 'G0 X60', '', 'G1 X120 F600'], 6000);
    expect(plan.cum).toHaveLength(3);
    expect(plan.total).toBeCloseTo(6.6, 6);
  });

  it('weights progress by time, not by line count', () => {
    // one long cut line and many tiny engraving moves
    const lines = ['G1 X100 F100', ...Array.from({ length: 99 }, (_, i) => `G1 X${100 + (i + 1) * 0.1} F6000`)];
    const plan = progressPlan(lines, 6000);
    expect(jobTiming(plan, 1, 60).frac).toBeGreaterThan(0.99);
  });

  it('scales the remaining time by the measured pace', () => {
    const plan = progressPlan(['G1 X100 F600', 'G1 X200'], 6000); // 10 s + 10 s
    expect(jobTiming(plan, 1, 20).remainingS).toBeCloseTo(20, 6); // running at half speed
    expect(jobTiming(plan, 0, 0).remainingS).toBeCloseTo(20, 6);
  });
});
