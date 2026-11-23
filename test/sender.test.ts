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
  it('streams a long job without ever overflowing the 128-byte RX buffer', () => {
    conn.runJob(job(800));
    // MockGrbl throws on overflow; draining executes everything
    mock.drain();
    const sent = mock.received.filter((l) => l.startsWith('G1'));
    expect(sent).toHaveLength(800);
    expect(mock.received[mock.received.length - 1]).toBe('G4 P0');
  });

  it('strips comments and blank lines from job G-code', () => {
    conn.runJob(['; header', '', 'G0 X1 ; move', 'M5']);
    mock.drain();
    expect(mock.received.slice(0, 2)).toEqual(['G0 X1', 'M5']);
    expect(last().total).toBe(2);
  });
});

describe('completion', () => {
  it('is not done when every line is acknowledged but the machine still moves', () => {
    conn.runJob(job(20));
    mock.step(); // execute all 20 lines → all acked, planner still busy
    expect(last().acked).toBe(20);
    expect(last().state).toBe('completing');
    mock.reportStatus(); // Run
    expect(last().state).toBe('completing');
  });

  it('is done only after the sync dwell is acknowledged and the machine reports Idle', () => {
    conn.runJob(job(20));
    mock.step();
    mock.finishMotion();
    mock.step(); // G4 P0 can now be acknowledged
    expect(last().state).toBe('completing');
    mock.reportStatus(); // Idle
    expect(last().state).toBe('done');
    expect(conn.jobActive).toBe(false);
  });

  it('runs consecutive jobs with independent progress', () => {
    for (let k = 0; k < 3; k++) {
      conn.runJob(job(50 + k));
      mock.drain();
      mock.reportStatus();
      expect(last()).toMatchObject({ state: 'done', total: 50 + k, acked: 50 + k, errors: 0 });
    }
  });
});

describe('manual commands', () => {
  it('are refused while a job is active (running, paused or completing)', () => {
    conn.runJob(job(10));
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

  it('acknowledgements of manual commands are not counted as job progress', () => {
    conn.send(['G0 X5', 'G0 Y5']); // in flight, not executed yet
    conn.runJob(job(3));
    mock.step(2); // executes the two manual lines
    expect(last().acked).toBe(0);
    mock.step();
    expect(last().acked).toBe(3);
  });

  it('refuses to start a job when the machine is not idle', () => {
    mock.alarm(1);
    mock.reportStatus();
    expect(() => conn.runJob(job(5))).toThrow(/NOT_IDLE/);
  });

  it('reads $$ settings', async () => {
    const p = conn.readSettings();
    mock.step();
    await expect(p).resolves.toMatchObject({ $30: '1000', $32: '1' });
  });
});

describe('errors and interruptions', () => {
  it('stops on a G-code error: feed hold first, then reset after the hold settles', () => {
    const lines = job(40);
    lines[5] = 'G1 BAD';
    conn.runJob(lines);
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
      conn.runJob(lines);
      mock.step();
      expect(last().state).toBe('failed');
      vi.advanceTimersByTime(60);
      expect(mock.rx).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and never resumes streaming after an unexpected controller reset', () => {
    conn.runJob(job(300));
    mock.step(10);
    mock.softReset(); // spontaneous restart mid-job
    expect(last()).toMatchObject({ state: 'aborted', reason: 'reset' });
    const count = mock.received.length;
    mock.drain();
    mock.reportStatus();
    expect(mock.received.length).toBe(count);
  });

  it('aborts on an alarm', () => {
    conn.runJob(job(100));
    mock.step(5);
    mock.alarm(2);
    expect(last()).toMatchObject({ state: 'aborted', reason: 'alarm' });
  });

  it('aborts when the connection is lost', () => {
    conn.runJob(job(100));
    mock.step(5);
    mock.disconnect();
    expect(last()).toMatchObject({ state: 'aborted', reason: 'disconnected' });
    expect(closed).toBe(true);
    expect(() => conn.send(['G0 X0'])).toThrow('NOT_CONNECTED');
  });

  it('STOP soft-resets immediately and reports a user stop (not a crash)', () => {
    conn.runJob(job(100));
    mock.step(5);
    conn.abort();
    expect(last()).toMatchObject({ state: 'aborted', reason: 'stopped' });
    expect(log.some((l) => l.startsWith('Grbl'))).toBe(true); // the mock reset itself
    expect(mock.rx).toHaveLength(0);
  });

  it('pause sends a feed hold and resume continues to completion', () => {
    conn.runJob(job(30));
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
