import { useEffect, useState } from 'react';
import type { Anchor, Item, Layer, MachineProfile, OriginMode } from '../core/types';
import type { TraceOptions } from '../core/trace';
import { shapePaths } from '../core/shapes';
import { useGrbl, type PortInfo } from '../machine/useGrbl';
import { errorText, t } from '../i18n';
import { NumField } from './DesignBars';
import { kerfFromMeasurement } from '../core/kerf';

type G = ReturnType<typeof useGrbl>;

// ---------- Machine connection + console ----------
export function ConnectionPanel({ g, machine, setMachine, locked }: { g: G; machine: MachineProfile; setMachine: (m: MachineProfile) => void; locked: boolean }) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState('');
  const [cmd, setCmd] = useState('');
  const refresh = async () => {
    const l = await window.laser.listPorts();
    setPorts(l);
    if (!port && l.length) setPort(l[0].path);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="panel">
      <h3>{t('conn.title')}</h3>
      <div className="row">
        <select value={port} onChange={(e) => setPort(e.target.value)} disabled={g.connected}>
          {ports.length === 0 && <option value="">{t('conn.noPorts')}</option>}
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path} {p.friendlyName || p.manufacturer}
            </option>
          ))}
        </select>
        <button onClick={refresh} disabled={g.connected} title={t('conn.rescan')}>
          ⟳
        </button>
      </div>
      <div className="row">
        <select value={machine.baud} onChange={(e) => setMachine({ ...machine, baud: +e.target.value })} disabled={g.connected}>
          {[115200, 250000, 57600, 9600].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        {g.connected ? (
          <button onClick={g.disconnect} disabled={locked}>
            {t('conn.disconnect')}
          </button>
        ) : (
          <button className="go" disabled={!port} onClick={() => g.connect(port, machine.baud).catch((e) => alert(t('conn.openFailed', { msg: errorText(e) })))}>
            {t('conn.connect')}
          </button>
        )}
      </div>
      <div className="console">
        {g.log
          .slice(-80)
          .reverse()
          .map((l, i) => (
            <div key={i} className={l.startsWith('error') || l.startsWith('ALARM') ? 'err' : l.startsWith('>') ? 'out' : ''}>
              {l}
            </div>
          ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (cmd.trim()) g.send(cmd.trim());
          setCmd('');
        }}
      >
        {/* Locked while a job runs: manual commands must never be mixed into a job */}
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={locked ? t('job.busy') : t('conn.cmdPlaceholder')} disabled={!g.connected || locked} />
        <button disabled={!g.connected || locked}>{t('conn.send')}</button>
      </form>
    </section>
  );
}

// ---------- Jogging, origin, homing ----------
/** Warn when the positioning beam has been on this long (s) */
const FIRE_WARN_S = 30;
export function JogPanel({ g, jog, disabled, sMax, firePower }: { g: G; jog: (dx: number, dy: number, step: number, feed: number) => void; disabled: boolean; sMax: number; firePower: number }) {
  const [step, setStep] = useState(10);
  const [feed, setFeed] = useState(3000);
  // Fire: a low-power beam to see where the laser points. It stays on until clicked again
  // (the main process still switches it off before a job, on STOP and on disconnect).
  // After FIRE_WARN_S seconds a warning reminds not to leave it on one spot.
  const [fireSince, setFireSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => window.laser.onFire(({ on }) => setFireSince(on ? Date.now() : null)), []);
  useEffect(() => {
    if (fireSince === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [fireSince]);
  const firing = fireSince !== null;
  const fireSecs = firing ? Math.floor((now - fireSince) / 1000) : 0;
  const fire = async () => {
    if (firing) return window.laser.fire(false);
    setNow(Date.now());
    await window.laser.fire(true, Math.round((sMax * firePower) / 100)).catch((e: Error) => g.push(`⚠ ${e.message}`));
  };


  return (
    <section className="panel">
      <h3>{t('jog.title')}</h3>
      <div className="jog">
        <span />
        <button disabled={disabled} onClick={() => jog(0, 1, step, feed)}>▲ Y+</button>
        <span />
        <button disabled={disabled} onClick={() => jog(-1, 0, step, feed)}>◀ X−</button>
        <button disabled={disabled} onClick={() => g.send('G90 G0 X0 Y0')} title={t('jog.home')}>⌂</button>
        <button disabled={disabled} onClick={() => jog(1, 0, step, feed)}>X+ ▶</button>
        <span />
        <button disabled={disabled} onClick={() => jog(0, -1, step, feed)}>▼ Y−</button>
        <span />
      </div>
      <div className="row">
        <label>{t('jog.step')}</label>
        {[0.1, 1, 10, 50].map((s) => (
          <button key={s} className={s === step ? 'sel' : ''} onClick={() => setStep(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className="row">
        <label>{t('jog.speed')}</label>
        <input type="number" value={feed} onChange={(e) => setFeed(+e.target.value)} />
      </div>
      <div className="row wrap">
        <button disabled={disabled} onClick={() => g.send('G10 L20 P1 X0 Y0')} title={t('jog.setOriginTip')}>
          📍 {t('jog.setOrigin')}
        </button>
        <button disabled={disabled} onClick={() => g.send('$H')} title={t('jog.homingTip')}>
          {t('jog.homing')}
        </button>
        <button disabled={!g.connected} onClick={() => g.send('$X')} title={t('jog.unlockTip')}>
          {t('jog.unlock')}
        </button>
        <button disabled={disabled} className={firing ? 'firing' : ''} onClick={fire} title={t('jog.fireTip')}>
          {firing ? `🔴 ${t('jog.fireOff')} · ${fireSecs}s` : `🔆 ${t('jog.fire', { power: firePower })}`}
        </button>
      </div>
      {firing && fireSecs >= FIRE_WARN_S && <div className="fire-warn">{t('jog.fireLong', { s: fireSecs })}</div>}
      <div className="row wrap" title={t('jog.airTip')}>
        <label>{t('jog.airTest')}</label>
        <button disabled={disabled} onClick={() => g.send('M8')}>{t('jog.airOn')}</button>
        <button disabled={disabled} onClick={() => g.send('M9')}>{t('jog.airOff')}</button>
      </div>
    </section>
  );
}

// ---------- Job origin, framing, machine profile ----------
const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

export function JobPanel(p: {
  originMode: OriginMode;
  setOriginMode: (m: OriginMode) => void;
  anchor: Anchor;
  setAnchor: (a: Anchor) => void;
  machine: MachineProfile;
  setMachine: (m: MachineProfile) => void;
}) {
  const m = p.machine;
  return (
    <section className="panel">
      <h3>{t('jobp.title')}</h3>
      <div className="row">
        <select value={p.originMode} onChange={(e) => p.setOriginMode(e.target.value as OriginMode)}>
          <option value="absolute">{t('jobp.absolute')}</option>
          <option value="current">{t('jobp.current')}</option>
        </select>
      </div>
      {p.originMode === 'current' && (
        <div className="row">
          <label>{t('jobp.anchor')}</label>
          <div className="anchors">
            {ANCHORS.map((a) => (
              <button key={a} className={a === p.anchor ? 'sel' : ''} onClick={() => p.setAnchor(a)} />
            ))}
          </div>
        </div>
      )}
      <div className="grid2">
        <label>{t('jobp.machine')}</label>
        <input value={m.name} onChange={(e) => p.setMachine({ ...m, name: e.target.value })} />
        <label>{t('jobp.laser')}</label>
        <input value={m.laser} onChange={(e) => p.setMachine({ ...m, laser: e.target.value })} />
        <label>{t('jobp.frameSpeed')}</label>
        <input type="number" value={m.frameSpeed} onChange={(e) => p.setMachine({ ...m, frameSpeed: +e.target.value })} />
        <label>{t('jobp.framePower')}</label>
        <input type="number" step={0.5} min={0} max={5} value={m.framePower} onChange={(e) => p.setMachine({ ...m, framePower: Math.min(5, +e.target.value) })} />
        <label>{t('jobp.bed')}</label>
        <div className="row">
          <input type="number" value={m.bedW} onChange={(e) => p.setMachine({ ...m, bedW: +e.target.value })} />
          <input type="number" value={m.bedH} onChange={(e) => p.setMachine({ ...m, bedH: +e.target.value })} />
        </div>
        <label>{t('jobp.sMax')}</label>
        <input type="number" value={m.sMax} onChange={(e) => p.setMachine({ ...m, sMax: +e.target.value })} />
        <label>{t('jobp.firePower')}</label>
        <input type="number" step={1} min={1} max={10} value={m.firePower ?? 3} onChange={(e) => p.setMachine({ ...m, firePower: Math.min(10, Math.max(1, +e.target.value || 1)) })} />
        <label title={t('jobp.airAssistTip')}>{t('jobp.airAssist')}</label>
        <input type="checkbox" checked={!!m.airAssist} title={t('jobp.airAssistTip')} onChange={(e) => p.setMachine({ ...m, airAssist: e.target.checked })} />
      </div>
    </section>
  );
}

// ---------- Properties of the single selected object ----------
export function ItemPanel({ item, layers, patch, onTrace, onSavePreset }: { item: Item; layers: Layer[]; patch: (p: Partial<Item>) => void; onTrace: (o: TraceOptions) => void; onSavePreset: (it: Item) => void }) {
  const [th, setTh] = useState(128);
  const [smooth, setSmooth] = useState(0.8);
  /** Changing a shape parameter (corner radius, sides) regenerates the paths at the current size */
  const reshape = (spec: NonNullable<Item['shape']>) => {
    const paths = shapePaths(spec, item.w, item.h);
    if (paths) patch({ shape: spec, paths, srcW: item.w, srcH: item.h });
  };
  return (
    <section className="panel">
      <h3 title={item.name}>{t('item.title', { name: item.name })}</h3>
      <div className="row">
        <label>{t('item.name')}</label>
        <input value={item.name} onChange={(e) => patch({ name: e.target.value })} />
      </div>
      <div className="row">
        <label>{t('item.layer')}</label>
        <select value={item.layerId} onChange={(e) => patch({ layerId: e.target.value })}>
          {layers
            .filter((l) => (item.kind === 'bitmap') === (l.mode === 'image'))
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </div>
      <div className="row">
        <button onClick={() => patch({ w: item.srcW, h: item.srcH })}>{t('item.origSize')}</button>
      </div>
      {item.shape?.type === 'rect' && (
        <div className="row">
          <label>{t('item.radius')}</label>
          <NumField value={item.shape.radius ?? 0} min={0} step={0.5} onCommit={(v) => reshape({ type: 'rect', radius: v })} />
        </div>
      )}
      {item.shape?.type === 'polygon' && (
        <div className="row">
          <label>{t('item.sides')}</label>
          <NumField value={item.shape.sides ?? 6} min={3} step={1} onCommit={(v) => reshape({ type: 'polygon', sides: Math.round(v) })} />
        </div>
      )}
      {item.kind === 'bitmap' && (
        <>
          <h4>{t('item.traceTitle')}</h4>
          <div className="row">
            <label>{t('item.threshold')}</label>
            <input type="range" min={1} max={254} value={th} onChange={(e) => setTh(+e.target.value)} />
            <span className="muted">{th}</span>
          </div>
          <div className="row">
            <label>{t('item.smooth')}</label>
            <input type="range" min={0} max={3} step={0.1} value={smooth} onChange={(e) => setSmooth(+e.target.value)} />
            <span className="muted">{smooth}</span>
          </div>
          <button onClick={() => onTrace({ threshold: th, minArea: 0.5, smooth })}>✎ {t('item.trace')}</button>
        </>
      )}
      {item.override && (
        <>
          <h4>{t('item.override')}</h4>
          <div className="muted">{t('item.overrideHint')}</div>
          <div className="grid4">
            <label>{t('lp.speed')}</label>
            <NumField value={item.override.speed ?? 0} min={1} step={10} onCommit={(v) => patch({ override: { ...item.override, speed: v } })} />
            <label>{t('lp.power')}</label>
            <NumField value={item.override.power ?? 0} min={0} step={1} onCommit={(v) => patch({ override: { ...item.override, power: Math.min(100, v) } })} />
          </div>
          <div className="row wrap">
            <button className="go" onClick={() => onSavePreset(item)}>
              ⤴ {t('item.saveToLib')}
            </button>
            <button onClick={() => patch({ override: undefined })}>{t('item.overrideClear')}</button>
          </div>
        </>
      )}
      <h4>{t('item.copiesTitle')}</h4>
      <div className="grid4">
        <label>{t('item.cols')}</label>
        <input type="number" min={1} value={item.copies.cols} onChange={(e) => patch({ copies: { ...item.copies, cols: Math.max(1, Math.floor(+e.target.value)) } })} />
        <label>{t('item.rows')}</label>
        <input type="number" min={1} value={item.copies.rows} onChange={(e) => patch({ copies: { ...item.copies, rows: Math.max(1, Math.floor(+e.target.value)) } })} />
        <label>{t('item.gapX')}</label>
        <input type="number" step={0.5} value={item.copies.gapX} onChange={(e) => patch({ copies: { ...item.copies, gapX: +e.target.value } })} />
        <label>{t('item.gapY')}</label>
        <input type="number" step={0.5} value={item.copies.gapY} onChange={(e) => patch({ copies: { ...item.copies, gapY: +e.target.value } })} />
      </div>
      <div className="muted">{t('item.total', { n: item.copies.cols * item.copies.rows })}</div>
    </section>
  );
}

// ---------- Layer (cut settings) list — runs from top to bottom ----------
export function LayersPanel(p: {
  layers: Layer[];
  counts: Record<string, number>;
  patch: (id: string, patch: Partial<Layer>) => void;
  reset: () => void;
  add: () => void;
  remove: (id: string) => void;
  move: (from: number, to: number) => void;
  fromLib: (l: Layer) => void;
  toLib: (l: Layer) => void;
  /** The machine switches air assist with M8/M9 */
  airAssist: boolean;
}) {
  const { layers, patch } = p;
  const [kerfCalc, setKerfCalc] = useState<{ id: string; nominal: number; measured: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  return (
    <section className="panel">
      <h3>
        {t('layers.title')}{' '}
        <button className="tiny" onClick={p.reset}>
          {t('layers.reset')}
        </button>
        <button className="tiny" onClick={p.add} title={t('layers.add')}>
          ＋
        </button>
      </h3>
      <div className="muted">{t('layers.orderHint')}</div>
      {layers.map((l, idx) => (
        <div
          key={l.id}
          className={`layer ${dragOver === idx && dragFrom !== idx ? 'drop' : ''}`}
          draggable
          onDragStart={(e) => {
            setDragFrom(idx);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(idx);
          }}
          onDragEnd={() => {
            setDragFrom(null);
            setDragOver(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && dragFrom !== idx) p.move(dragFrom, idx);
            setDragFrom(null);
            setDragOver(null);
          }}
        >
          <div className="layer-head" onClick={() => setOpen(open === l.id ? null : l.id)}>
            <span className="grip" title={t('layers.orderHint')}>⋮⋮</span>
            <span className="order">{idx + 1}</span>
            <input type="checkbox" checked={l.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => patch(l.id, { enabled: e.target.checked })} />
            <span className="swatch" style={{ background: l.color }} />
            <b>{l.name}</b>
            <span className="muted">{t('layers.summary', { speed: l.speed, power: l.power, passes: l.passes })}</span>
          </div>
          {open === l.id && (
            <>
            <div className="row wrap layer-actions">
              <button disabled={idx === 0} title={t('layers.up')} onClick={() => p.move(idx, idx - 1)}>▲</button>
              <button disabled={idx === layers.length - 1} title={t('layers.down')} onClick={() => p.move(idx, idx + 1)}>▼</button>
              <button onClick={() => p.fromLib(l)}>📚 {t('layers.fromLib')}</button>
              <button onClick={() => p.toLib(l)}>⤴ {t('layers.toLib')}</button>
              <span className="muted">{t('layers.objects', { n: p.counts[l.id] ?? 0 })}</span>
              <button title={t('layers.delete')} onClick={() => p.remove(l.id)}>🗑</button>
            </div>
            <div className="grid2">
              <label>{t('lp.name')}</label>
              <input value={l.name} onChange={(e) => patch(l.id, { name: e.target.value })} />
              <label>{t('lp.mode')}</label>
              <select value={l.mode} onChange={(e) => patch(l.id, { mode: e.target.value as Layer['mode'] })}>
                <option value="line">{t('mode.line')}</option>
                <option value="fill">{t('mode.fill')}</option>
                <option value="image">{t('mode.image')}</option>
              </select>
              <label>{t('lp.speed')}</label>
              <input type="number" value={l.speed} onChange={(e) => patch(l.id, { speed: Math.max(1, +e.target.value) })} />
              <label>{t('lp.power')}</label>
              <input type="number" min={0} max={100} value={l.power} onChange={(e) => patch(l.id, { power: Math.min(100, Math.max(0, +e.target.value)) })} />
              <label>{t('lp.passes')}</label>
              <input type="number" min={1} value={l.passes} onChange={(e) => patch(l.id, { passes: Math.max(1, Math.floor(+e.target.value)) })} />
              <label>{t('lp.air')}</label>
              <div className="row">
                {/* Always editable; when the machine option is off the pump is not switched, so say so plainly */}
                <input type="checkbox" checked={!!l.air} onChange={(e) => patch(l.id, { air: e.target.checked })} />
                {l.air && !p.airAssist && <span className="air-warn">⚠ {t('lp.airOffTip')}</span>}
              </div>
              {l.mode === 'line' && (
                <>
                  <label title={t('lp.kerfTip')}>{t('lp.kerf')}</label>
                  <div className="row">
                    <NumField value={l.kerf ?? 0} min={0} step={0.01} title={t('lp.kerfTip')} onCommit={(v) => patch(l.id, { kerf: Math.min(2, v) })} />
                    <button className="tiny" title={t('lp.kerfCalc')} onClick={() => setKerfCalc(kerfCalc?.id === l.id ? null : { id: l.id, nominal: 20, measured: 20 })}>
                      📏
                    </button>
                  </div>
                  {kerfCalc?.id === l.id && (
                    <div className="kerf-calc">
                      <div className="muted">{t('lp.kerfHow')}</div>
                      <div className="grid2">
                        <label>{t('lp.kerfNominal')}</label>
                        <NumField value={kerfCalc.nominal} min={1} step={1} onCommit={(v) => setKerfCalc({ ...kerfCalc, nominal: v })} />
                        <label>{t('lp.kerfMeasured')}</label>
                        <NumField value={kerfCalc.measured} min={0} step={0.01} onCommit={(v) => setKerfCalc({ ...kerfCalc, measured: v })} />
                      </div>
                      <div className="row">
                        <span className="muted">{t('lp.kerfResult', { kerf: kerfFromMeasurement(kerfCalc.nominal, kerfCalc.measured).toFixed(3) })}</span>
                        <button
                          className="go"
                          onClick={() => {
                            patch(l.id, { kerf: +kerfFromMeasurement(kerfCalc.nominal, kerfCalc.measured).toFixed(3) });
                            setKerfCalc(null);
                          }}
                        >
                          {t('lp.kerfApply')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {l.mode !== 'line' && (
                <>
                  <label>{t('lp.interval')}</label>
                  <input type="number" step={0.01} min={0.03} value={l.lineInterval} onChange={(e) => patch(l.id, { lineInterval: Math.max(0.03, +e.target.value) })} />
                  <label>{t('lp.overscan')}</label>
                  <input type="number" step={0.5} min={0} value={l.overscan} onChange={(e) => patch(l.id, { overscan: Math.max(0, +e.target.value) })} />
                  <label>{t('lp.bidir')}</label>
                  <input type="checkbox" checked={l.bidirectional} onChange={(e) => patch(l.id, { bidirectional: e.target.checked })} />
                </>
              )}
              {l.mode === 'image' && (
                <>
                  <label>{t('lp.dither')}</label>
                  <select value={l.dither} onChange={(e) => patch(l.id, { dither: e.target.value as Layer['dither'] })}>
                    <option value="floyd">{t('dither.floyd')}</option>
                    <option value="threshold">{t('dither.threshold')}</option>
                    <option value="grayscale">{t('dither.grayscale')}</option>
                  </select>
                  {l.dither === 'threshold' && (
                    <>
                      <label>{t('lp.threshold')}</label>
                      <input type="range" min={1} max={254} value={l.threshold} onChange={(e) => patch(l.id, { threshold: +e.target.value })} />
                    </>
                  )}
                  {l.dither === 'grayscale' && (
                    <>
                      <label>{t('lp.minPower')}</label>
                      <input type="number" min={0} max={l.power} value={l.minPower} onChange={(e) => patch(l.id, { minPower: +e.target.value })} />
                    </>
                  )}
                </>
              )}
            </div>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
