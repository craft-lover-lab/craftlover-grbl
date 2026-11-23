import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pt } from '../core/types';
import { t, type Key } from '../i18n';

export interface PortInfo {
  path: string;
  manufacturer: string;
  friendlyName: string;
}

export interface JobProgress {
  running: boolean;
  paused: boolean;
  total: number;
  sent: number;
  acked: number;
  errors: number;
}

export interface GrblStatus {
  state: string; // Idle, Run, Hold:0, Jog, Alarm, Door, Check, Home, Sleep
  mpos: Pt;
  wpos: Pt;
  feed: number;
  spindle: number;
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
      openFiles(): Promise<{ name: string; data: Uint8Array }[]>;
      saveText(name: string, text: string, kind?: 'gcode' | 'project'): Promise<boolean>;
      openProject(): Promise<{ name: string; text: string } | null>;
      epsToPdf(data: Uint8Array): Promise<Uint8Array>;
      listFonts(): Promise<{ name: string; file: string }[]>;
      readFont(file: string): Promise<Uint8Array>;
      setLang(lang: string): Promise<void>;
      onLine(cb: (l: string) => void): () => void;
      onProgress(cb: (p: JobProgress) => void): () => void;
      onClosed(cb: () => void): () => void;
    };
  }
}

/** GRBL alarm codes that get a human-readable explanation in the console. */
const ALARMS = new Set(['1', '2', '3', '8', '9']);

export function useGrbl() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<GrblStatus>({ state: '—', mpos: { x: 0, y: 0 }, wpos: { x: 0, y: 0 }, feed: 0, spindle: 0 });
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [version, setVersion] = useState('');
  const wco = useRef<Pt>({ x: 0, y: 0 });

  const push = useCallback((l: string) => setLog((old) => [...old.slice(-400), l]), []);

  useEffect(() => {
    if (!window.laser) return;
    const off1 = window.laser.onLine((line) => {
      if (line.startsWith('<')) {
        setStatus(parseStatus(line, wco.current));
        return;
      }
      if (/^Grbl|^GrblHAL/i.test(line)) setVersion(line);
      const am = line.match(/^ALARM:(\d+)/);
      push(am && ALARMS.has(am[1]) ? `${line}  ← ${t(`alarm.${am[1]}` as Key)}` : line);
    });
    const off2 = window.laser.onProgress((p) => setProgress(p));
    const off3 = window.laser.onClosed(() => {
      setConnected(false);
      push(t('log.disconnected'));
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, [push]);

  const connect = useCallback(
    async (path: string, baud: number) => {
      await window.laser.open(path, baud);
      setConnected(true);
      push(t('log.connected', { port: path, baud }));
      // GRBL boards usually reset when the port opens; send $I to confirm the version
      setTimeout(() => window.laser.send(['$I']), 1500);
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
      return window.laser.send(arr);
    },
    [push],
  );

  return { connected, status, log, progress, version, connect, disconnect, send, push, wco };
}

function parseStatus(line: string, wco: Pt): GrblStatus {
  const body = line.replace(/^<|>$/g, '').split('|');
  const st: GrblStatus = { state: body[0], mpos: { x: 0, y: 0 }, wpos: { x: 0, y: 0 }, feed: 0, spindle: 0 };
  let hasM = false;
  let hasW = false;
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
