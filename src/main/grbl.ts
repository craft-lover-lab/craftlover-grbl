/**
 * GRBL 1.1 sender.
 *
 * Streams G-code with the "character counting" protocol: keep sending while the bytes
 * sitting in GRBL's RX buffer stay <= RX_BUFFER_SIZE; every "ok"/"error" frees the
 * oldest line. Each in-flight line remembers where it came from (job / manual / sync),
 * so replies are attributed to the right command.
 *
 * Job life cycle:
 *   idle → running ⇄ paused → completing → done
 *                     ↘ aborted (STOP, alarm, reset, disconnect) / failed (G-code error)
 *
 * "completing": every job line was acknowledged, but the machine may still be moving.
 * A final `G4 P0` (sync) is only acknowledged once GRBL's planner is empty, and the job
 * is reported done only after that ack *and* a following "Idle" status report.
 */

/** GRBL 1.1 RX buffer size (the Sculpfun S30 board also uses 128 bytes; keep 1 byte spare). */
export const RX_BUFFER_SIZE = 127;

export type JobState = 'idle' | 'running' | 'paused' | 'completing' | 'done' | 'aborted' | 'failed';
export type StopReason = 'stopped' | 'alarm' | 'reset' | 'disconnected' | 'error';

export interface JobProgress {
  state: JobState;
  total: number;
  sent: number;
  acked: number;
  errors: number;
  /** Why the job ended early (aborted / failed) */
  reason?: StopReason;
  /** Details for failures, e.g. the rejected line and GRBL error code */
  detail?: string;
}

export interface GrblEvents {
  onLine: (line: string) => void;
  onProgress: (p: JobProgress) => void;
  onClose: () => void;
}

/** Byte stream to the controller (a serial port in the app, a mock in tests). */
export interface Transport {
  write(data: string | Uint8Array): void;
  close(): void;
}

/** Opens a transport and feeds received lines / close events back. */
export type TransportFactory = (path: string, baud: number, on: { line: (l: string) => void; close: () => void; error: (msg: string) => void }) => Promise<Transport>;

export interface GrblOptions {
  open: TransportFactory;
  /** Status poll interval in ms ("?" real-time command); 0 disables polling (tests) */
  pollMs?: number;
  /** Stop the job when GRBL rejects a line (default true) */
  stopOnError?: boolean;
  /** How long to wait for a feed hold to settle before the safety reset (ms) */
  holdTimeoutMs?: number;
}

type Source = 'job' | 'manual' | 'sync';
interface InFlight {
  len: number;
  src: Source;
  line: string;
  /** 1-based job line number (job lines only) */
  n?: number;
}

const ACTIVE: JobState[] = ['running', 'paused', 'completing'];

export class GrblConnection {
  private t: Transport | null = null;
  private jobQueue: string[] = [];
  private manualQueue: string[] = [];
  private inFlight: InFlight[] = [];
  private job: JobProgress = { state: 'idle', total: 0, sent: 0, acked: 0, errors: 0 };
  private syncAcked = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while we are resetting the controller ourselves (STOP / safety stop) */
  private resetting = false;
  /** Last machine state from a status report, e.g. "Idle", "Run", "Hold:0", "Alarm" */
  machineState = '';
  /** Latest $-settings seen in replies to "$$" */
  settings: Record<string, string> = {};
  private settingsWaiters: { resolve: (s: Record<string, string>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    private ev: GrblEvents,
    private opt: GrblOptions,
  ) {}

  get isOpen() {
    return !!this.t;
  }

  get jobActive() {
    return ACTIVE.includes(this.job.state);
  }

  get progress(): JobProgress {
    return { ...this.job };
  }

  async open(path: string, baud: number) {
    this.close();
    this.t = await this.opt.open(path, baud, {
      line: (l) => this.handleLine(l.trim()),
      close: () => this.onTransportClosed(),
      error: (msg) => this.ev.onLine(`[PORT ERROR] ${msg}`),
    });
    this.machineState = '';
    this.settings = {};
    this.startPolling();
  }

  close() {
    const t = this.t;
    this.t = null;
    this.stopPolling();
    t?.close();
    this.endJob('aborted', 'disconnected');
    this.clearQueues();
  }

  /** Real-time commands (bypass the queue): '?', '!', '~', 0x18, 0x85 ... */
  realtime(byte: number | string) {
    if (!this.t) return;
    this.t.write(typeof byte === 'number' ? Uint8Array.of(byte) : byte);
  }

  /**
   * Manual commands (console, jog, set origin, frame …).
   * Refused while a job is active so they can never be mixed into it.
   */
  send(lines: string[]) {
    if (!this.t) throw new Error('NOT_CONNECTED');
    if (this.jobActive) throw new Error('BUSY');
    for (const l of lines) {
      const s = l.trim();
      if (s) this.manualQueue.push(s);
    }
    this.pump();
  }

  /** Start a job. The caller is expected to have checked the machine state first. */
  runJob(lines: string[]) {
    if (!this.t) throw new Error('NOT_CONNECTED');
    if (this.jobActive) throw new Error('JOB_RUNNING');
    const state = this.machineState.split(':')[0];
    if (state && state !== 'Idle') throw new Error(`NOT_IDLE:${this.machineState}`);
    const clean = lines.map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
    this.job = { state: 'running', total: clean.length, sent: 0, acked: 0, errors: 0 };
    this.syncAcked = false;
    this.jobQueue = clean;
    this.emitProgress(true);
    this.pump();
  }

  pause() {
    if (this.job.state !== 'running' && this.job.state !== 'completing') return;
    this.realtime('!');
    this.job.state = 'paused';
    this.emitProgress(true);
  }

  resume() {
    if (this.job.state !== 'paused') return;
    this.realtime('~');
    this.job.state = this.job.acked >= this.job.total ? 'completing' : 'running';
    this.emitProgress(true);
  }

  /**
   * STOP button: immediate soft reset (Ctrl-X). GRBL stops motion and turns the laser off.
   * This is a software stop — it does not replace a physical emergency switch.
   */
  abort() {
    this.clearQueues();
    this.resetting = true;
    this.realtime(0x18);
    this.endJob('aborted', 'stopped');
  }

  /**
   * Read GRBL's settings with "$$". Resolves once the final "ok" arrives.
   * Refused while a job is active.
   */
  readSettings(timeoutMs = 3000): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      try {
        this.send(['$$']);
      } catch (e) {
        return reject(e);
      }
      const timer = setTimeout(() => {
        this.settingsWaiters = this.settingsWaiters.filter((w) => w.timer !== timer);
        reject(new Error('SETTINGS_TIMEOUT'));
      }, timeoutMs);
      this.settingsWaiters.push({ resolve, reject, timer });
    });
  }

  // ---------------------------------------------------------------------------

  private clearQueues() {
    this.jobQueue = [];
    this.manualQueue = [];
    this.inFlight = [];
    for (const w of this.settingsWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('ABORTED'));
    }
    this.settingsWaiters = [];
  }

  private endJob(state: 'done' | 'aborted' | 'failed', reason?: StopReason, detail?: string) {
    if (!this.jobActive) return;
    this.job.state = state;
    this.job.reason = reason;
    this.job.detail = detail;
    this.jobQueue = [];
    this.emitProgress(true);
  }

  /**
   * Safety stop after a G-code error: stop feeding lines, feed-hold so the head
   * decelerates without losing position (GRBL turns the laser off in hold), then
   * soft-reset to flush whatever is still buffered.
   */
  private safetyStop(detail: string) {
    this.jobQueue = [];
    this.manualQueue = [];
    this.endJob('failed', 'error', detail);
    this.realtime('!');
    const reset = () => {
      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.holdTimer = null;
      this.clearQueues();
      this.resetting = true;
      this.realtime(0x18);
    };
    this.pendingHoldReset = reset;
    this.holdTimer = setTimeout(reset, this.opt.holdTimeoutMs ?? 3000);
  }
  private pendingHoldReset: (() => void) | null = null;

  private onTransportClosed() {
    this.t = null;
    this.stopPolling();
    this.endJob('aborted', 'disconnected');
    this.clearQueues();
    this.ev.onClose();
  }

  private pump() {
    if (!this.t) return;
    let used = this.inFlight.reduce((a, b) => a + b.len, 0);
    for (;;) {
      // Manual commands only flow when no job is active; job lines only while running/paused
      let next: { line: string; src: Source } | null = null;
      if (this.manualQueue.length && !this.jobActive) next = { line: this.manualQueue[0], src: 'manual' };
      else if (this.jobQueue.length && (this.job.state === 'running' || this.job.state === 'paused')) next = { line: this.jobQueue[0], src: 'job' };
      else if (this.jobActive && this.job.sent === this.job.total && !this.syncAcked && !this.inFlight.some((f) => f.src === 'sync'))
        next = { line: 'G4 P0', src: 'sync' };
      if (!next) break;
      const data = next.line + '\n';
      if (used + data.length > RX_BUFFER_SIZE && this.inFlight.length > 0) break;
      if (next.src === 'manual') this.manualQueue.shift();
      if (next.src === 'job') this.jobQueue.shift();
      const entry: InFlight = { len: data.length, src: next.src, line: next.line };
      if (next.src === 'job') entry.n = ++this.job.sent;
      this.inFlight.push(entry);
      used += data.length;
      this.t.write(data);
    }
    this.emitProgress();
  }

  private handleLine(line: string) {
    if (!line) return;

    if (line.startsWith('<')) {
      this.onStatus(line);
      this.ev.onLine(line);
      return;
    }

    if (line === 'ok' || line.startsWith('error:')) {
      const f = this.inFlight.shift();
      const isError = line !== 'ok';
      if (f?.src === 'job') {
        this.job.acked++;
        if (isError) {
          this.job.errors++;
          if (this.opt.stopOnError !== false) this.safetyStop(`#${f.n}: ${f.line} → ${line}`);
        }
        if (this.job.state === 'running' && this.job.acked >= this.job.total) this.job.state = 'completing';
      } else if (f?.src === 'sync') {
        this.syncAcked = true;
        if (this.job.state === 'running') this.job.state = 'completing';
      } else if (f?.src === 'manual' && f.line === '$$') {
        for (const w of this.settingsWaiters.splice(0)) {
          clearTimeout(w.timer);
          if (isError) w.reject(new Error(line));
          else w.resolve({ ...this.settings });
        }
      }
      if (isError) this.ev.onLine(f ? `${line}  ← ${f.line}` : line);
      this.pump();
      this.emitProgress(true);
      return;
    }

    const setting = line.match(/^\$(\d+)=([^\s(]+)/);
    if (setting) this.settings[`$${setting[1]}`] = setting[2];

    if (line.startsWith('ALARM:')) {
      this.clearQueues();
      this.endJob('aborted', 'alarm', line);
    }

    if (/^Grbl\b|^GrblHAL\b/i.test(line)) {
      // The controller restarted: its buffers are empty and anything still queued
      // must never be sent on its own — the job cannot continue.
      this.clearQueues();
      this.endJob('aborted', this.resetting ? 'stopped' : 'reset');
      this.resetting = false;
      this.machineState = '';
    }
    this.ev.onLine(line);
  }

  private onStatus(line: string) {
    this.machineState = line.replace(/^<|>$/g, '').split('|')[0];
    const state = this.machineState.split(':')[0];
    if (state === 'Alarm' && this.jobActive) {
      this.clearQueues();
      this.endJob('aborted', 'alarm', this.machineState);
    }
    // Hold:0 = hold complete (the head has stopped) → safe to reset after a G-code error
    if (this.machineState === 'Hold:0' && this.pendingHoldReset) {
      const r = this.pendingHoldReset;
      this.pendingHoldReset = null;
      r();
    }
    // Done only when the sync dwell was acknowledged and the machine reports Idle afterwards
    if (this.job.state === 'completing' && this.syncAcked && state === 'Idle') this.endJob('done');
  }

  private startPolling() {
    this.stopPolling();
    const ms = this.opt.pollMs ?? 250;
    if (ms > 0) this.pollTimer = setInterval(() => this.realtime('?'), ms);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private lastEmit = 0;
  private emitProgress(force = false) {
    if (this.job.state === 'idle') return;
    const now = Date.now();
    // Throttle streaming updates, but always send state changes
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    this.ev.onProgress({ ...this.job });
  }
}
