import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pt } from '../core/types';
import { t, type Key } from '../i18n';

export interface PortInfo {
  path: string;
  manufacturer: string;
  friendlyName: string;
}

export type JobState = 'idle' | 'running' | 'paused' | 'completing' | 'done' | 'aborted' | 'failed';
export type StopReason = 'stopped' | 'alarm' | 'reset' | 'disconnected' | 'error';

/** Mirrors JobProgress in src/main/grbl.ts */
export interface JobProgress {
  state: JobState;
  total: number;
  sent: number;
  acked: number;
  errors: number;
  reason?: StopReason;
  detail?: string;
}

export const isJobActive = (p: JobProgress | null) => !!p && (p.state === 'running' || p.state === 'paused' || p.state === 'completing');

export interface GrblStatus {
  state: string; // Idle, Run, Hold:0, Jog, Alarm, Door, Check, Home, Sleep
  mpos: Pt;
  wpos: Pt;
  feed: number;
  spindle: number;
  /** Air pump (coolant M8/M7) as reported in the "A:" accessory field; undefined until known */
  air?: boolean;
}

declare global {
  interface Window {
    laser: {
      listPorts(): Promise<PortInfo[]>;
      open(path: string, baud: number): Promise<void>;
      close(): Promise<void>;
      send(lines: string[]): Promise<void>;
      realtime(b: number | string): Promise<void>;
      run(lines: string[]): Promise<void>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      abort(): Promise<void>;
      checkMachine(): Promise<{ state: string; settings: Record<string, string>; jobActive: boolean; homed: boolean }>;
      fire(on: boolean, s?: number, maxS?: number): Promise<void>;
      onFire(cb: (v: { on: boolean }) => void): () => void;
      onStopping(cb: (v: { on: boolean }) => void): () => void;
      openFiles(): Promise<{ name: string; data: Uint8Array }[]>;
      saveText(name: string, text: string, kind?: 'gcode' | 'project'): Promise<boolean>;
      openProject(): Promise<{ name: string; text: string } | null>;
      saveProject(text: string, saveAs: boolean, defaultName: string): Promise<{ name: string } | null>;
      forgetProject(): Promise<void>;
      autosaveWrite(text: string): Promise<void>;
      autosaveRead(): Promise<{ text: string; time: number } | null>;
      autosaveClear(): Promise<void>;
      epsToPdf(data: Uint8Array): Promise<Uint8Array>;
      listFonts(): Promise<{ name: string; file: string }[]>;
      readFont(file: string): Promise<Uint8Array>;
      setLang(lang: string): Promise<void>;
      loadLibrary(): Promise<unknown>;
      saveLibrary(presets: unknown): Promise<void>;
      exportLibrary(text: string): Promise<boolean>;
      importLibrary(): Promise<string | null>;
      onLine(cb: (l: string) => void): () => void;
      onProgress(cb: (p: JobProgress) => void): () => void;
      onClosed(cb: () => void): () => void;
    };
  }
}

/** GRBL alarm and error codes that get a human-readable explanation in the console. */
const ALARMS = new Set(['1', '2', '3', '8', '9']);
const ERRORS = new Set(['5', '9', '15', '20']);

export function useGrbl() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<GrblStatus>({ state: '—', mpos: { x: 0, y: 0 }, wpos: { x: 0, y: 0 }, feed: 0, spindle: 0 });
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [version, setVersion] = useState('');
  /** A STOP is in progress (hold → reset → first status): commands are refused meanwhile */
  const [stopping, setStopping] = useState(false);
  const wco = useRef<Pt>({ x: 0, y: 0 });

  const push = useCallback((l: string) => setLog((old) => [...old.slice(-400), l]), []);

  useEffect(() => {
    if (!window.laser) return;
    const off1 = window.laser.onLine((line) => {
      if (line.startsWith('<')) {
        setStatus((prev) => parseStatus(line, wco.current, prev.air));
        return;
      }
      if (/^Grbl|^GrblHAL/i.test(line)) setVersion(line);
      const am = line.match(/^ALARM:(\d+)/);
      const em = line.match(/^error:(\d+)/);
      if (am && ALARMS.has(am[1])) push(`${line}  ← ${t(`alarm.${am[1]}` as Key)}`);
      else if (em && ERRORS.has(em[1])) push(`${line}  ⓘ ${t(`grblerr.${em[1]}` as Key)}`);
      else push(line);
    });
    let last: JobState | null = null;
    const off2 = window.laser.onProgress((p) => {
      setProgress(p);
      if (p.state === last) return;
      last = p.state;
      // Report how the job ended; anything but a normal finish or the user's own STOP gets an alert
      if (p.state === 'done') push(t('job.done'));
      if (p.state === 'aborted' || p.state === 'failed') {
        const msg = p.state === 'failed' ? t('job.failed', { detail: p.detail ?? '' }) : t(`job.reason.${p.reason ?? 'stopped'}` as Key);
        push(`⚠ ${msg}`);
        if (p.reason !== 'stopped') setTimeout(() => alert(msg), 0);
      }
    });
    const off4 = window.laser.onStopping(({ on }) => setStopping(on));
    const off3 = window.laser.onClosed(() => {
      setConnected(false);
      setStatus((st) => ({ ...st, air: undefined }));
      push(t('log.disconnected'));
    });
    return () => {
      off1();
      off2();
      off3();
      off4();
    };
  }, [push]);

  const connect = useCallback(
    async (path: string, baud: number) => {
      await window.laser.open(path, baud);
      setConnected(true);
      push(t('log.connected', { port: path, baud }));
      // GRBL boards usually reset when the port opens; send $I to confirm the version
      setTimeout(() => window.laser.send(['$I']).catch(() => {}), 1500);
    },
    [push],
  );

  const disconnect = useCallback(async () => {
    await window.laser.close();
    setConnected(false);
  }, []);

  const send = useCallback(
    (lines: string[] | string) => {
      const arr = Array.isArray(lines) ? lines : [lines];
      arr.forEach((l) => push(`> ${l}`));
      return window.laser.send(arr).catch((e: Error) => {
        // Manual commands are refused while a job runs, so they can never mix into it
        push(e.message.includes('BUSY') ? `⚠ ${t('job.busy')}` : e.message.includes('STOPPING') ? `⚠ ${t('err.stopping')}` : `⚠ ${e.message}`);
      });
    },
    [push],
  );

  return { connected, status, log, progress, jobActive: isJobActive(progress), stopping, version, connect, disconnect, send, push, wco };
}

/**
 * Parse a GRBL 1.1 status report. `prevAir` carries the air state between reports: GRBL only
 * sends the accessory field "A:" together with "Ov:" (every few reports, and right after an
 * accessory changes), and leaves "A:" out entirely when nothing is on.
 */
export function parseStatus(line: string, wco: Pt, prevAir?: boolean): GrblStatus {
  const body = line.replace(/^<|>$/g, '').split('|');
  const st: GrblStatus = { state: body[0], mpos: { x: 0, y: 0 }, wpos: { x: 0, y: 0 }, feed: 0, spindle: 0, air: prevAir };
  let hasM = false;
  let hasW = false;
  const fields = body.slice(1).map((f) => f.split(':')[0]);
  const acc = body.find((f) => f.startsWith('A:'));
  if (acc) st.air = /[FM]/.test(acc.slice(2));
  else if (fields.includes('Ov')) st.air = false;
  for (const f of body.slice(1)) {
    const [k, v] = f.split(':');
    const n = (v ?? '').split(',').map(Number);
    if (k === 'MPos') (st.mpos = { x: n[0], y: n[1] }), (hasM = true);
    else if (k === 'WPos') (st.wpos = { x: n[0], y: n[1] }), (hasW = true);
    else if (k === 'WCO') {
      wco.x = n[0];
      wco.y = n[1];
    } else if (k === 'FS' || k === 'F') {
      st.feed = n[0];
      st.spindle = n[1] ?? 0;
    }
  }
  // GRBL only reports WCO now and then; derive the missing position
  if (hasM && !hasW) st.wpos = { x: st.mpos.x - wco.x, y: st.mpos.y - wco.y };
  if (hasW && !hasM) st.mpos = { x: st.wpos.x + wco.x, y: st.wpos.y + wco.y };
  return st;
}
