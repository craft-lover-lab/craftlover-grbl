import { SerialPort, ReadlineParser } from 'serialport';

/** GRBL 1.1 RX buffer size (the Sculpfun S30 board also uses 128 bytes; keep 1 byte spare). */
const RX_BUFFER_SIZE = 127;

export interface JobProgress {
  running: boolean;
  paused: boolean;
  total: number;
  sent: number;
  acked: number;
  errors: number;
}

export interface GrblEvents {
  onLine: (line: string) => void;
  onProgress: (p: JobProgress) => void;
  onClose: () => void;
}

/**
 * GRBL connection over a COM port using the "character counting" protocol:
 * keep sending while the bytes sitting in GRBL's buffer stay <= 127.
 * Each "ok"/"error" reply frees the oldest line.
 */
export class GrblConnection {
  private port: SerialPort | null = null;
  private queue: string[] = [];
  private inFlight: number[] = [];
  private job: JobProgress = { running: false, paused: false, total: 0, sent: 0, acked: 0, errors: 0 };
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private ev: GrblEvents) {}

  static async list() {
    const ports = await SerialPort.list();
    return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? '', friendlyName: (p as any).friendlyName ?? '' }));
  }

  get isOpen() {
    return !!this.port?.isOpen;
  }

  open(path: string, baudRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.close();
      const port = new SerialPort({ path, baudRate, autoOpen: false });
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (raw: string) => this.handleLine(raw.trim()));
      port.on('close', () => {
        this.stopPolling();
        this.resetQueue();
        this.port = null;
        this.ev.onClose();
      });
      port.on('error', (err) => this.ev.onLine(`[PORT ERROR] ${err.message}`));
      port.open((err) => {
        if (err) return reject(err);
        this.port = port;
        this.startPolling();
        resolve();
      });
    });
  }

  close() {
    this.stopPolling();
    if (this.port?.isOpen) this.port.close();
    this.port = null;
    this.resetQueue();
  }

  /** Real-time commands (bypass the queue): '?', '!', '~', 0x18, 0x85 ... */
  realtime(byte: number | string) {
    if (!this.port?.isOpen) return;
    const buf = typeof byte === 'number' ? Buffer.from([byte]) : Buffer.from(byte, 'latin1');
    this.port.write(buf);
  }

  /** Send one or more manual commands (MDI, jog, set origin). */
  send(lines: string[]) {
    for (const l of lines) {
      const s = l.trim();
      if (s) this.queue.push(s);
    }
    this.pump();
  }

  runJob(lines: string[]) {
    if (this.job.running) throw new Error('JOB_RUNNING');
    const clean = lines.map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
    this.job = { running: true, paused: false, total: clean.length, sent: 0, acked: 0, errors: 0 };
    this.queue.push(...clean);
    this.emitProgress();
    this.pump();
  }

  pause() {
    this.realtime('!');
    if (this.job.running) {
      this.job.paused = true;
      this.emitProgress();
    }
  }

  resume() {
    this.realtime('~');
    if (this.job.running) {
      this.job.paused = false;
      this.emitProgress();
    }
  }

  /** Emergency stop: soft reset (Ctrl-X) — GRBL turns the laser off and clears its buffer at once. */
  abort() {
    this.queue = [];
    this.inFlight = [];
    this.realtime(0x18);
    if (this.job.running) {
      this.job.running = false;
      this.job.paused = false;
      this.emitProgress();
    }
  }

  private resetQueue() {
    this.queue = [];
    this.inFlight = [];
    if (this.job.running) {
      this.job.running = false;
      this.emitProgress();
    }
  }

  private pump() {
    if (!this.port?.isOpen) return;
    let used = this.inFlight.reduce((a, b) => a + b, 0);
    while (this.queue.length) {
      const line = this.queue[0] + '\n';
      if (used + line.length > RX_BUFFER_SIZE && this.inFlight.length > 0) break;
      this.queue.shift();
      this.inFlight.push(line.length);
      used += line.length;
      this.port.write(line);
      if (this.job.running) this.job.sent++;
    }
    if (this.job.running) this.emitProgress();
  }

  private handleLine(line: string) {
    if (!line) return;
    if (line === 'ok' || line.startsWith('error:')) {
      this.inFlight.shift();
      if (this.job.running) {
        this.job.acked++;
        if (line.startsWith('error:')) this.job.errors++;
        if (this.job.acked >= this.job.total && this.queue.length === 0) {
          this.job.running = false;
          this.job.paused = false;
          this.emitProgress();
        }
      }
      if (line !== 'ok') this.ev.onLine(line);
      this.pump();
      return;
    }
    if (line.startsWith('ALARM:')) {
      // Machine alarm: drop the rest of the job
      this.queue = [];
      this.inFlight = [];
      if (this.job.running) {
        this.job.running = false;
        this.emitProgress();
      }
    }
    if (line.startsWith('Grbl ') || line.startsWith('GrblHAL')) {
      // The board just restarted → its buffer is empty
      this.inFlight = [];
    }
    this.ev.onLine(line);
  }

  private startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.realtime('?'), 250);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private lastEmit = 0;
  private emitProgress() {
    const now = Date.now();
    // Throttle updates, but always send the final state
    if (this.job.running && !this.job.paused && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    this.ev.onProgress({ ...this.job });
  }
}
