import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrblConnection, type JobProgress } from '../src/main/grbl';
import { MockGrbl } from './mockGrbl';

let mock: MockGrbl;
let conn: GrblConnection;
let events: JobProgress[];
let log: string[];
let closed: boolean;

const last = () => events[events.length - 1];
const job = (n: number, prefix = 'G1') => Array.from({ length: n }, (_, i) => `${prefix} X${(i % 400).toFixed(3)} Y${((i * 7) % 400).toFixed(3)} S500`);

beforeEach(async () => {
  mock = new MockGrbl();
  events = [];
  log = [];
  closed = false;
  conn = new GrblConnection(
    { onLine: (l) => log.push(l), onProgress: (p) => events.push(p), onClose: () => (closed = true) },
    { open: mock.factory, pollMs: 0, holdTimeoutMs: 50 },
  );
  await conn.open('MOCK', 115200);
  mock.reportStatus(); // machine reports Idle
});

describe('streaming', () => {
  it('streams a long job without ever overflowing the 128-byte RX buffer', async () => {
    await conn.runJob(job(800));
    // MockGrbl throws on overflow; draining executes everything
    mock.drain();
    const sent = mock.received.filter((l) => l.startsWith('G1'));
    expect(sent).toHaveLength(800);
    expect(mock.received[mock.received.length - 1]).toBe('G4 P0');
  });

  it('strips comments and blank lines from job G-code', async () => {
    await conn.runJob(['; header', '', 'G0 X1 ; move', 'M5']);
    mock.drain();
    expect(mock.received.slice(0, 2)).toEqual(['G0 X1', 'M5']);
    expect(last().total).toBe(2);
  });
});

describe('completion', () => {
  it('is not done when every line is acknowledged but the machine still moves', async () => {
    await conn.runJob(job(20));
    mock.step(); // execute all 20 lines → all acked, planner still busy
    expect(last().acked).toBe(20);
    expect(last().state).toBe('completing');
    mock.reportStatus(); // Run
    expect(last().state).toBe('completing');
  });

  it('is done only after the sync dwell is acknowledged and the machine reports Idle', async () => {
    await conn.runJob(job(20));
    mock.step();
    mock.finishMotion();
    mock.step(); // G4 P0 can now be acknowledged
    expect(last().state).toBe('completing');
    mock.reportStatus(); // Idle
    expect(last().state).toBe('done');
    expect(conn.jobActive).toBe(false);
  });

  it('runs consecutive jobs with independent progress', async () => {
    for (let k = 0; k < 3; k++) {
      await conn.runJob(job(50 + k));
      mock.drain();
      mock.reportStatus();
      expect(last()).toMatchObject({ state: 'done', total: 50 + k, acked: 50 + k, errors: 0 });
    }
  });
});

describe('manual commands', () => {
  it('are refused while a job is active (running, paused or completing)', async () => {
    await conn.runJob(job(10));
    expect(() => conn.send(['G0 X0'])).toThrow('BUSY');
    conn.pause();
    expect(() => conn.send(['$X'])).toThrow('BUSY');
    conn.resume();
    mock.step();
    expect(last().state).toBe('completing');
    expect(() => conn.send(['G0 X0'])).toThrow('BUSY');
    mock.finishMotion();
    mock.step();
    mock.reportStatus();
    expect(() => conn.send(['G0 X0'])).not.toThrow();
  });

  it('acknowledgements of manual commands are not counted as job progress', async () => {
    conn.send(['G0 X5', 'G0 Y5']); // in flight, not executed yet
    const started = conn.runJob(job(3));
    mock.step(2); // executes the two manual lines
    mock.finishMotion();
    await started;
    expect(last().acked).toBe(0);
    mock.step();
    expect(last().acked).toBe(3);
  });

  it('refuses to start a job when the machine is not idle', async () => {
    mock.alarm(1);
    await expect(conn.runJob(job(5))).rejects.toThrow(/NOT_IDLE/);
  });

  it('reads $$ settings', async () => {
    const p = conn.readSettings();
    mock.step();
    await expect(p).resolves.toMatchObject({ $30: '1000', $32: '1' });
  });
});

describe('errors and interruptions', () => {
  it('stops on a G-code error: feed hold first, then reset after the hold settles', async () => {
    const lines = job(40);
    lines[5] = 'G1 BAD';
    await conn.runJob(lines);
    mock.step();
    expect(last()).toMatchObject({ state: 'failed', reason: 'error' });
    expect(last().detail).toContain('BAD');
    expect(mock.state).toBe('Hold:1'); // held — the remaining buffered lines are not executed
    const before = mock.received.length;
    mock.holdComplete();
    mock.reportStatus(); // Hold:0 → sender resets
    expect(log.some((l) => l.startsWith('Grbl'))).toBe(true);
    expect(mock.rx).toHaveLength(0);
    expect(mock.received.length).toBe(before); // nothing else was sent
  });

  it('falls back to a reset when the hold never reports complete', async () => {
    vi.useFakeTimers();
    try {
      const lines = job(10);
      lines[0] = 'BAD';
      await conn.runJob(lines);
      mock.step();
      expect(last().state).toBe('failed');
      vi.advanceTimersByTime(60);
      expect(mock.rx).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and never resumes streaming after an unexpected controller reset', async () => {
    await conn.runJob(job(300));
    mock.step(10);
    mock.softReset(); // spontaneous restart mid-job
    expect(last()).toMatchObject({ state: 'aborted', reason: 'reset' });
    const count = mock.received.length;
    mock.drain();
    mock.reportStatus();
    expect(mock.received.length).toBe(count);
  });

  it('aborts on an alarm', async () => {
    await conn.runJob(job(100));
    mock.step(5);
    mock.alarm(2);
    expect(last()).toMatchObject({ state: 'aborted', reason: 'alarm' });
  });

  it('aborts when the connection is lost', async () => {
    await conn.runJob(job(100));
    mock.step(5);
    mock.disconnect();
    expect(last()).toMatchObject({ state: 'aborted', reason: 'disconnected' });
    expect(closed).toBe(true);
    expect(() => conn.send(['G0 X0'])).toThrow('NOT_CONNECTED');
  });

  it('STOP holds first and resets only once the head has stopped — no alarm, position kept', async () => {
    await conn.runJob(job(100));
    mock.step(5); // moving
    conn.abort();
    expect(last()).toMatchObject({ state: 'aborted', reason: 'stopped' });
    expect(mock.state).toBe('Hold:1'); // decelerating, not reset yet
    expect(mock.resets).toBe(0);
    mock.holdComplete();
    mock.reportStatus(); // Hold:0 → reset now
    expect(mock.resets).toBe(1);
    expect(mock.state).toBe('Idle'); // not locked by ALARM:3
    expect(log.some((l) => l.startsWith('ALARM'))).toBe(false);
    expect(mock.rx).toHaveLength(0);
    // Locked until the restarted controller reports its state again
    expect(() => conn.send(['G90 G0 X0 Y0'])).toThrow('STOPPING');
    mock.reportStatus();
    expect(() => conn.send(['G90 G0 X0 Y0'])).not.toThrow(); // can return to the origin
  });

  it('refuses every new command between STOP and the end of the reset (regression)', async () => {
    const stopping: boolean[] = [];
    const c = new GrblConnection(
      { onLine: () => {}, onProgress: () => {}, onClose: () => {}, onStopping: (on) => stopping.push(on) },
      { open: mock.factory, pollMs: 0 },
    );
    await c.open('MOCK', 115200);
    mock.reportStatus();
    await c.runJob(job(100));
    mock.step(5);
    c.abort();
    expect(c.isStopping).toBe(true);
    expect(stopping).toEqual([true]);
    // During the hold: jog, Fire and a new job are all refused, nothing reaches the controller
    const before = mock.received.length;
    expect(() => c.send(['$J=G91 X10 F1000'])).toThrow('STOPPING');
    expect(() => c.fire(30)).toThrow('STOPPING');
    await expect(c.runJob(job(2))).rejects.toThrow('STOPPING');
    expect(mock.received.length).toBe(before);
    mock.holdComplete();
    mock.reportStatus(); // Hold:0 → reset → banner
    expect(mock.resets).toBe(1);
    // Right after the restart: still refused until a status report confirms the state
    expect(() => c.send(['G0 X0'])).toThrow('STOPPING');
    mock.reportStatus();
    expect(c.isStopping).toBe(false);
    expect(stopping).toEqual([true, false]);
    expect(() => c.send(['G0 X0'])).not.toThrow();
    c.close();
  });

  it('unlocks after a timeout when the controller never confirms the reset', async () => {
    vi.useFakeTimers();
    try {
      const c = new GrblConnection({ onLine: (l) => log.push(l), onProgress: () => {}, onClose: () => {} }, { open: mock.factory, pollMs: 0, stoppingTimeoutMs: 2000 });
      await c.open('MOCK', 115200);
      mock.state = 'Run';
      mock.planner = 1;
      c.abort(); // Hold:1, and the hold never completes; reset at 1.5 s
      mock.silent = true; // controller goes silent: no banner, no status
      vi.advanceTimersByTime(1600);
      expect(c.isStopping).toBe(true);
      vi.advanceTimersByTime(500);
      expect(c.isStopping).toBe(false);
      expect(log.some((l) => l.includes('did not confirm'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('STOP resets at once when the machine is already idle', async () => {
    conn.abort();
    expect(mock.resets).toBe(1); // the status asked for right after the hold says Idle
  });

  it('STOP falls back to a reset when the hold never completes', async () => {
    vi.useFakeTimers();
    try {
      await conn.runJob(job(100));
      mock.step(5);
      conn.abort();
      expect(mock.resets).toBe(0);
      vi.advanceTimersByTime(1600);
      expect(mock.resets).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause sends a feed hold and resume continues to completion', async () => {
    await conn.runJob(job(30));
    mock.step(5);
    conn.pause();
    expect(mock.state).toBe('Hold:1');
    expect(last().state).toBe('paused');
    mock.step(); // held: nothing runs
    const acked = last().acked;
    conn.resume();
    expect(last().state).toBe('running');
    mock.drain();
    mock.reportStatus();
    expect(acked).toBeLessThan(30);
    expect(last().state).toBe('done');
  });
});

describe('review round 2', () => {
  it('waits for earlier manual commands, then requires a fresh Idle status', async () => {
    conn.send(['G0 X10']);
    const p = conn.runJob(job(3));
    await Promise.resolve();
    expect(mock.received.filter((l) => l.startsWith('G1'))).toHaveLength(0); // job not started yet
    mock.step(); // G0 acknowledged, but the machine is still moving (Run)
    await expect(p).rejects.toThrow(/NOT_IDLE:Run/);
    mock.finishMotion();
    await conn.runJob(job(3));
    mock.step();
    expect(last().acked).toBe(3);
  });

  it('gives up when manual commands never finish', async () => {
    vi.useFakeTimers();
    try {
      conn.send(['G0 X10']);
      const p = conn.runJob(job(3));
      const check = expect(p).rejects.toThrow('MANUAL_PENDING');
      await vi.advanceTimersByTimeAsync(6000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets exactly once when the hold timeout fires before Hold:0 arrives', async () => {
    vi.useFakeTimers();
    try {
      const lines = job(10);
      lines[0] = 'BAD';
      await conn.runJob(lines);
      mock.step();
      vi.advanceTimersByTime(60); // fallback reset
      expect(mock.resets).toBe(1);
      mock.state = 'Hold:0';
      mock.reportStatus(); // a late Hold:0 must not trigger a second reset
      expect(mock.resets).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a safety timer from an old connection never touches a new one', async () => {
    vi.useFakeTimers();
    try {
      let current = mock;
      const c2 = new GrblConnection(
        { onLine: () => {}, onProgress: (p) => events.push(p), onClose: () => {} },
        { open: (...a) => current.factory(...a), pollMs: 0, holdTimeoutMs: 50 },
      );
      await c2.open('MOCK', 115200);
      mock.reportStatus();
      const lines = job(10);
      lines[0] = 'BAD';
      await c2.runJob(lines);
      mock.step(); // error → safety stop pending
      c2.close(); // user disconnects before the hold settles
      current = new MockGrbl();
      await c2.open('MOCK', 115200); // reconnect quickly
      vi.advanceTimersByTime(5000);
      expect(current.resets).toBe(0);
      current.state = 'Hold:0';
      current.reportStatus();
      expect(current.resets).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the positioning beam on until it is switched off (no auto-off)', async () => {
    vi.useFakeTimers();
    try {
      conn.fire(30);
      mock.step();
      expect(mock.received).toContain('M3 S30');
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(mock.received).not.toContain('M5 S0');
      expect(conn.firing).toBe(true);
      conn.fireOff();
      expect(mock.received).toContain('M5 S0');
      expect(conn.firing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Fire switches itself off after its maximum on-time', async () => {
    vi.useFakeTimers();
    try {
      conn.fire(30, 300_000);
      mock.step();
      vi.advanceTimersByTime(299_000);
      expect(conn.firing).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(conn.firing).toBe(false);
      expect(mock.received).toContain('M5 S0');
      expect(log.some((l) => l.includes('maximum on-time'))).toBe(true);
      // Switching it off by hand cancels the timer: a later Fire gets its own full time
      conn.fire(30, 300_000);
      mock.step();
      conn.fireOff();
      conn.fire(30, 300_000);
      mock.step();
      vi.advanceTimersByTime(200_000);
      expect(conn.firing).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

    it('STOP and a controller reset also end the beam', async () => {
    conn.fire(30);
    mock.step();
    conn.abort();
    mock.holdComplete();
    mock.reportStatus();
    expect(conn.firing).toBe(false);
  });

  it('turns the beam off before a job and on disconnect', async () => {
    conn.fire(10);
    mock.step();
    mock.finishMotion();
    const p = conn.runJob(job(2));
    mock.step(); // M5 from fireOff
    mock.finishMotion();
    await p;
    expect(mock.received.indexOf('M5 S0')).toBeLessThan(mock.received.findIndex((l) => l.startsWith('G1 X')));
    expect(conn.firing).toBe(false);
    expect(() => conn.fire(10)).toThrow('BUSY'); // never during a job
    mock.drain();
    mock.reportStatus(); // job done

    conn.fire(10);
    const before = mock.received.length;
    conn.close();
    expect(mock.received.slice(before)).toContain('M5 S0');
  });

  it('forgets homing on alarm and reset', async () => {
    conn.send(['$H']);
    mock.step();
    expect(conn.homed).toBe(true);
    mock.softReset();
    expect(conn.homed).toBe(false);
  });
});
