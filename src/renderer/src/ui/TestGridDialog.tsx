import { useState } from 'react';
import { DEFAULT_TEST, rowValues, steps, type TestGridOptions } from '../core/testGrid';
import { t } from '../i18n';
import { NumField } from './DesignBars';

/** Dialog that configures a speed × power material test grid. */
export function TestGridDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (o: TestGridOptions) => Promise<void> }) {
  const [o, setO] = useState<TestGridOptions>(() => {
    try {
      return { ...DEFAULT_TEST, ...JSON.parse(localStorage.getItem('testGrid') ?? '{}') };
    } catch {
      return DEFAULT_TEST;
    }
  });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<TestGridOptions>) => setO((v) => ({ ...v, ...p }));
  const w = o.cols * (o.cell + o.gap) - o.gap;
  const h = o.rows * (o.cell + o.gap) - o.gap;
  const speeds = steps(o.speedMin, o.speedMax, o.cols, 10);
  const scan = o.mode === 'scan';
  const rows = rowValues(o);

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>🧪 {t('test.title')}</h3>
        <div className="row">
          <label>{t('test.mode')}</label>
          <select value={o.mode} onChange={(e) => set({ mode: e.target.value as TestGridOptions['mode'] })}>
            <option value="fill">{t('test.modeFill')}</option>
            <option value="line">{t('test.modeLine')}</option>
            <option value="scan">{t('test.modeScan')}</option>
          </select>
        </div>
        <div className="grid-test">
          <span />
          <span className="muted">{t('test.from')}</span>
          <span className="muted">{t('test.to')}</span>
          <span className="muted">{t('test.steps')}</span>
          <label>{t('lp.speed')}</label>
          <NumField value={o.speedMin} min={1} step={100} onCommit={(v) => set({ speedMin: v })} />
          <NumField value={o.speedMax} min={1} step={100} onCommit={(v) => set({ speedMax: v })} />
          <NumField value={o.cols} min={1} step={1} onCommit={(v) => set({ cols: Math.min(20, Math.max(1, Math.round(v))) })} />
          {scan ? (
            <>
              <label>{t('test.offset')}</label>
              <NumField value={o.offsetMin ?? 0} min={-1} step={0.05} onCommit={(v) => set({ offsetMin: Math.max(-1, Math.min(1, v)) })} />
              <NumField value={o.offsetMax ?? 0.25} min={-1} step={0.05} onCommit={(v) => set({ offsetMax: Math.max(-1, Math.min(1, v)) })} />
            </>
          ) : (
            <>
              <label>{t('lp.power')}</label>
              <NumField value={o.powerMin} min={0} step={5} onCommit={(v) => set({ powerMin: Math.min(100, v) })} />
              <NumField value={o.powerMax} min={0} step={5} onCommit={(v) => set({ powerMax: Math.min(100, v) })} />
            </>
          )}
          <NumField value={o.rows} min={1} step={1} onCommit={(v) => set({ rows: Math.min(20, Math.max(1, Math.round(v))) })} />
        </div>
        <div className="grid4">
          <label>{t('test.cell')}</label>
          <NumField value={o.cell} min={2} step={1} onCommit={(v) => set({ cell: v })} />
          <label>{t('test.gap')}</label>
          <NumField value={o.gap} min={0} step={1} onCommit={(v) => set({ gap: v })} />
          {scan && (
            <>
              <label>{t('lp.power')}</label>
              <NumField value={o.scanPower ?? 40} min={1} step={5} onCommit={(v) => set({ scanPower: Math.min(100, Math.max(1, v)) })} />
            </>
          )}
          <label>{t('lp.passes')}</label>
          <NumField value={o.passes} min={1} step={1} onCommit={(v) => set({ passes: Math.max(1, Math.round(v)) })} />
          <label>X / Y</label>
          <div className="row">
            <NumField value={o.x} step={1} onCommit={(v) => set({ x: v })} />
            <NumField value={o.y} step={1} onCommit={(v) => set({ y: v })} />
          </div>
        </div>
        <label className="chk">
          <input type="checkbox" checked={o.labels} onChange={(e) => set({ labels: e.target.checked })} /> {t('test.labels')}
        </label>
        {o.labels && (
          <div className="row">
            <label>{t('test.labelSettings')}</label>
            <NumField value={o.labelSpeed} min={1} step={100} onCommit={(v) => set({ labelSpeed: v })} />
            <NumField value={o.labelPower} min={0} step={5} onCommit={(v) => set({ labelPower: Math.min(100, v) })} />
          </div>
        )}
        <div className="muted">
          {t('test.summary', { n: o.cols * o.rows, w: w.toFixed(0), h: h.toFixed(0) })}
          <br />
          {t('lp.speed')}: {speeds.join(' · ')}
          <br />
          {scan ? `${t('test.offset')}: ${rows.map((v) => v.toFixed(2)).join(' · ')}` : `${t('lp.power')}: ${rows.map((p) => `${p}%`).join(' · ')}`}
        </div>
        <div className="muted">{t(scan ? 'test.scanHowto' : 'test.howto')}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="go"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                localStorage.setItem('testGrid', JSON.stringify(o));
              } catch {
                /* ignore */
              }
              try {
                await onCreate(o);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('test.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
