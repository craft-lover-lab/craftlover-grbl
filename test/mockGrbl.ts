import type { Transport, TransportFactory } from '../src/main/grbl';

/**
 * A small GRBL 1.1 simulator for tests.
 *
 * - 128-byte RX buffer: writing more than that throws (character-counting violations fail the test)
 * - Lines are only executed when the test calls `step()`, so timing is fully deterministic
 * - Real-time bytes: '?' status, '!' feed hold, '~' resume, 0x18 soft reset
 * - "$$" replies with settings, lines containing "BAD" are rejected with error:20
 * - `G4 P0` is acknowledged only once no motion is pending (like the real planner sync)
 */
export class MockGrbl {
  static RX = 128;
  rx: string[] = [];
  rxBytes = 0;
  /** Every line the controller received, in order */
  received: string[] = [];
  state: 'Idle' | 'Run' | 'Hold:0' | 'Hold:1' | 'Alarm' = 'Idle';
  settings: Record<string, string> = { $30: '1000', $31: '0', $32: '1', $130: '410', $131: '400' };
  /** Motion queued in the planner (executed lines that "still move") */
  planner = 0;
  closed = false;
  /** How many soft resets the controller performed */
  resets = 0;
  private partial = '';
  private on!: { line: (l: string) => void; close: () => void; error: (m: string) => void };

  factory: TransportFactory = async (_path, _baud, on) => {
    this.on = on;
    const t: Transport = {
      write: (d) => this.write(d),
      close: () => this.disconnect(),
    };
    return t;
  };

  /** The controller stops answering (no ok, banner or status) — e.g. a hung board */
  silent = false;

  private reply(l: string) {
    if (!this.closed && !this.silent) this.on.line(l);
  }

  private write(d: string | Uint8Array) {
    if (this.closed) throw new Error('write after close');
    const text = typeof d === 'string' ? d : String.fromCharCode(...d);
    for (const ch of text) {
      if (ch === '?') this.reportStatus();
      else if (ch === '!') {
        if (this.state === 'Run' || this.planner > 0) this.state = 'Hold:1';
      } else if (ch === '~') {
        if (this.state.startsWith('Hold')) this.state = this.planner > 0 ? 'Run' : 'Idle';
      } else if (ch === '\x18') this.softReset();
      else if (ch === '\x85') {
        /* jog cancel */
      } else {
        this.partial += ch;
        if (ch === '\n') {
          const line = this.partial;
          this.partial = '';
          this.rxBytes += line.length;
          if (this.rxBytes > MockGrbl.RX) throw new Error(`RX buffer overflow: ${this.rxBytes} bytes`);
          this.rx.push(line.trim());
          this.received.push(line.trim());
        }
      }
    }
  }

  reportStatus() {
    this.reply(`<${this.state}|MPos:0.000,0.000,0.000|FS:0,0>`);
  }

  /** Finish the feed hold deceleration (Hold:1 → Hold:0). */
  holdComplete() {
    if (this.state === 'Hold:1') this.state = 'Hold:0';
  }

  /**
   * Execute up to `n` buffered lines (only while not held). Motion lines go into the planner;
   * call `finishMotion()` to let the planner drain.
   */
  step(n = Infinity) {
    while (n-- > 0 && this.rx.length && !this.state.startsWith('Hold') && this.state !== 'Alarm') {
      const line = this.rx[0];
      if (/^G4\s*P0/i.test(line) && this.planner > 0) return; // sync waits for the planner
      this.rx.shift();
      this.rxBytes -= line.length + 1;
      if (line.includes('BAD')) this.reply('error:20');
      else if (line === '$$') {
        for (const [k, v] of Object.entries(this.settings)) this.reply(`${k}=${v}`);
        this.reply('ok');
      } else {
        if (/^G[0-3]\b/i.test(line) || /^\$J=/.test(line)) {
          this.planner++;
          this.state = 'Run';
        }
        this.reply('ok');
      }
    }
  }

  /** The planner finished all queued moves. */
  finishMotion() {
    this.planner = 0;
    if (this.state === 'Run') this.state = 'Idle';
  }

  /** Run everything to completion: execute, finish motion, repeat. */
  drain() {
    for (let i = 0; i < 10000 && (this.rx.length || this.planner); i++) {
      this.step();
      this.finishMotion();
    }
  }

  alarm(code = 1) {
    this.state = 'Alarm';
    this.rx = [];
    this.rxBytes = 0;
    this.reply(`ALARM:${code}`);
  }

  /** Spontaneous controller restart (power glitch, watchdog …). */
  softReset() {
    this.resets++;
    // Like real GRBL: resetting while the head is still moving loses position → ALARM:3 (locked)
    const moving = this.state === 'Run' || this.state === 'Hold:1';
    this.rx = [];
    this.rxBytes = 0;
    this.planner = 0;
    this.partial = '';
    if (this.state !== 'Alarm') this.state = moving ? 'Alarm' : 'Idle';
    this.reply("Grbl 1.1h ['$' for help]");
    if (moving) this.reply('ALARM:3');
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    this.on.close();
  }
}
