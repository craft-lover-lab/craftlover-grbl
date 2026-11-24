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
 *
 * Every timer belongs to a connection "epoch". Opening, closing or resetting the
 * controller starts a new epoch, so a late timer from an old connection can never
 * act on a new one.
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
  /** The positioning beam ("Fire") was switched on or off */
  onFire?: (on: boolean) => void;
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
  /** How long runJob() waits for earlier manual commands to finish (ms) */
  manualDrainTimeoutMs?: number;
  /** How long to wait for a fresh status report (ms) */
  statusTimeoutMs?: number;
}

type Source = 'job' | 'manual' | 'sync';
interface InFlight {
  len: number;
  src: Source;
  line: string;
  /** 1-based job line number (job lines only) */
  n?: number;
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  /** Bumped on open / close — transport callbacks from an older port are ignored */
  private connId = 0;
  /** Bumped on open / close / controller reset — timers from older epochs do nothing */
  private epoch = 0;
  /** Pending "reset once the hold has settled" after a G-code error */
  private safety: { epoch: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The positioning beam (Fire) is on */
  private beamOn = false;
  /** True while we are resetting the controller ourselves (STOP / safety stop) */
  private resetting = false;
  /** Last machine state from a status report, e.g. "Idle", "Run", "Hold:0", "Alarm" */
  machineState = '';
  /** True after a successful $H in this connection; cleared by alarm, reset or disconnect */
  homed = false;
  /** Latest $-settings seen in replies to "$$" */
  settings: Record<string, string> = {};
  private settingsWaiters: Waiter<Record<string, string>>[] = [];
  private statusWaiters: Waiter<string>[] = [];
  private drainWaiters: Waiter<void>[] = [];

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

  get firing() {
    return this.beamOn;
  }

  async open(path: string, baud: number) {
    this.close();
    const id = ++this.connId;
    this.epoch++;
    const t = await this.opt.open(path, baud, {
      line: (l) => id === this.connId && this.handleLine(l.trim()),
      close: () => id === this.connId && this.onTransportClosed(),
      error: (msg) => this.ev.onLine(`[PORT ERROR] ${msg}`),
    });
    if (id !== this.connId) {
      // close() was called while the port was opening
      t.close();
      throw new Error('ABORTED');
    }
    this.t = t;
    this.machineState = '';
    this.settings = {};
    this.homed = false;
    this.startPolling();
  }

  close() {
    const t = this.t;
    if (t) this.fireOff(); // best effort: switch the positioning beam off before letting go
    this.t = null;
    this.connId++;
    this.epoch++;
    this.stopPolling();
    t?.close();
    this.endJob('aborted', 'disconnected');
    this.teardown();
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

  /**
   * Start a job. Waits until earlier manual commands are finished, then asks for a
   * fresh status report and only starts when the machine is really Idle.
   */
  async runJob(lines: string[]) {
    if (!this.t) throw new Error('NOT_CONNECTED');
    if (this.jobActive) throw new Error('JOB_RUNNING');
    this.fireOff();
    await this.waitManualDrained();
    const state = await this.freshStatus();
    if (state.split(':')[0] !== 'Idle') throw new Error(`NOT_IDLE:${state}`);
    if (this.jobActive) throw new Error('JOB_RUNNING');
    if (!this.t) throw new Error('NOT_CONNECTED');
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
    this.teardown();
    this.resetting = true;
    this.realtime(0x18);
    this.endJob('aborted', 'stopped');
  }

  /**
   * Positioning beam: constant low power (M3). It stays on until switched off — the UI warns
   * when it has been on for a while — but it is always switched off before a job, on STOP,
   * reset, alarm and disconnect. Refused while a job is active.
   */
  fire(sValue: number) {
    this.send([`M3 S${Math.max(0, Math.round(sValue))}`, 'G1 F1000']);
    this.beamOn = true;
    this.ev.onFire?.(true);
  }

  /** Switch the positioning beam off (no-op when it is not on). */
  fireOff() {
    if (!this.beamOn) return;
    this.beamOn = false;
    if (this.t && !this.jobActive) {
      try {
        this.send(['M5 S0']);
      } catch {
        /* not connected */
      }
    }
    this.ev.onFire?.(false);
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
      this.settingsWaiters.push(this.waiter(this.settingsWaiters, resolve, reject, timeoutMs, 'SETTINGS_TIMEOUT'));
    });
  }

  /** Ask for a status report and resolve with the state it contains. */
  freshStatus(timeoutMs = this.opt.statusTimeoutMs ?? 1000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.t) return reject(new Error('NOT_CONNECTED'));
      this.statusWaiters.push(this.waiter(this.statusWaiters, resolve, reject, timeoutMs, 'STATUS_TIMEOUT'));
      this.realtime('?');
    });
  }

  // ---------------------------------------------------------------------------

  private waiter<T>(list: Waiter<T>[], resolve: (v: T) => void, reject: (e: Error) => void, ms: number, code: string): Waiter<T> {
    const w: Waiter<T> = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = list.indexOf(w);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(code));
      }, ms),
    };
    return w;
  }

  private settle<T>(list: Waiter<T>[], v: T) {
    for (const w of list.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(v);
    }
  }

  private failAll(list: Waiter<unknown>[], code: string) {
    for (const w of list.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(code));
    }
  }

  private get manualPending() {
    return this.manualQueue.length > 0 || this.inFlight.some((f) => f.src === 'manual');
  }

  private waitManualDrained(): Promise<void> {
    if (!this.manualPending) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.drainWaiters.push(this.waiter(this.drainWaiters, resolve, reject, this.opt.manualDrainTimeoutMs ?? 5000, 'MANUAL_PENDING'));
    });
  }

  /** Drop queues, timers and waiters (STOP, reset, alarm, disconnect). */
  private teardown() {
    this.jobQueue = [];
    this.manualQueue = [];
    this.inFlight = [];
    this.cancelSafetyStop();
    if (this.beamOn) {
      // A reset / STOP / disconnect turns the laser off; just report it
      this.beamOn = false;
      this.ev.onFire?.(false);
    }
    this.failAll(this.settingsWaiters as Waiter<unknown>[], 'ABORTED');
    this.failAll(this.statusWaiters as Waiter<unknown>[], 'ABORTED');
    this.failAll(this.drainWaiters as Waiter<unknown>[], 'ABORTED');
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
   * soft-reset to flush whatever is still buffered — when Hold:0 is reported, or
   * after holdTimeoutMs at the latest. Exactly one reset is sent.
   */
  private safetyStop(detail: string) {
    this.jobQueue = [];
    this.manualQueue = [];
    this.endJob('failed', 'error', detail);
    this.realtime('!');
    this.cancelSafetyStop();
    const epoch = this.epoch;
    this.safety = { epoch, timer: setTimeout(() => this.safetyReset(epoch), this.opt.holdTimeoutMs ?? 3000) };
  }

  private safetyReset(epoch: number) {
    // Only the pending safety stop of this very connection may reset — and only once
    if (!this.safety || this.safety.epoch !== epoch || epoch !== this.epoch) return;
    this.cancelSafetyStop();
    this.teardown();
    this.resetting = true;
    this.realtime(0x18);
  }

  private cancelSafetyStop() {
    if (this.safety) clearTimeout(this.safety.timer);
    this.safety = null;
  }

  private onTransportClosed() {
    this.t = null;
    this.connId++;
    this.epoch++;
    this.stopPolling();
    this.homed = false;
    this.endJob('aborted', 'disconnected');
    this.teardown();
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
      } else if (f?.src === 'manual') {
        if (f.line === '$$') {
          if (isError) this.failAll(this.settingsWaiters as Waiter<unknown>[], line);
          else this.settle(this.settingsWaiters, { ...this.settings });
        }
        if (/^\$H$/i.test(f.line)) this.homed = !isError;
      }
      if (isError) this.ev.onLine(f ? `${line}  ← ${f.line}` : line);
      this.pump();
      if (!this.manualPending) this.settle(this.drainWaiters, undefined);
      this.emitProgress(true);
      return;
    }

    const setting = line.match(/^\$(\d+)=([^\s(]+)/);
    if (setting) this.settings[`$${setting[1]}`] = setting[2];

    if (line.startsWith('ALARM:')) {
      this.homed = false;
      this.teardown();
      this.endJob('aborted', 'alarm', line);
    }

    if (/^Grbl\b|^GrblHAL\b/i.test(line)) {
      // The controller restarted: its buffers are empty and anything still queued
      // must never be sent on its own — the job cannot continue. Old timers die with the epoch.
      this.epoch++;
      this.homed = false;
      this.teardown();
      this.endJob('aborted', this.resetting ? 'stopped' : 'reset');
      this.resetting = false;
      this.machineState = '';
    }
    this.ev.onLine(line);
  }

  private onStatus(line: string) {
    this.machineState = line.replace(/^<|>$/g, '').split('|')[0];
    const state = this.machineState.split(':')[0];
    if (state === 'Alarm') {
      this.homed = false;
      if (this.jobActive) {
        this.teardown();
        this.endJob('aborted', 'alarm', this.machineState);
      }
    }
    // Hold:0 = hold complete (the head has stopped) → safe to reset after a G-code error
    if (this.machineState === 'Hold:0' && this.safety) this.safetyReset(this.safety.epoch);
    // Done only when the sync dwell was acknowledged and the machine reports Idle afterwards
    if (this.job.state === 'completing' && this.syncAcked && state === 'Idle') this.endJob('done');
    this.settle(this.statusWaiters, this.machineState);
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
