import { useMemo, useState } from 'react';
import type { Layer, MaterialPreset } from '../core/types';
import { matchesMachine, mergePresets, normalizePresets } from '../core/materials';
import { uid } from '../core/geometry';
import { errorText, t } from '../i18n';
import { NumField } from './DesignBars';

interface Props {
  presets: MaterialPreset[];
  setPresets: (p: MaterialPreset[]) => void;
  machine: { name: string; laser: string };
  /** When opened from a layer: "Apply" copies the preset into this layer */
  target?: Layer;
  onApply?: (p: MaterialPreset) => void;
  /** Open straight into the editor with this new preset (e.g. "Save to library") */
  draft?: MaterialPreset;
  onClose: () => void;
  log: (msg: string) => void;
}

const modeKey = { line: 'mode.line', fill: 'mode.fill', image: 'mode.image' } as const;
const presetLabel = (p: MaterialPreset) => `${p.material} ${p.thickness} mm — ${p.operation}`;

export function MaterialLibrary(p: Props) {
  const [onlyMachine, setOnlyMachine] = useState(true);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<MaterialPreset | null>(p.draft ?? null);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return p.presets
      .filter((x) => !onlyMachine || matchesMachine(x, p.machine.name, p.machine.laser))
      .filter((x) => !s || `${x.material} ${x.operation} ${x.notes} ${x.machine} ${x.laser}`.toLowerCase().includes(s))
      .sort((a, b) => a.material.localeCompare(b.material) || a.thickness - b.thickness || a.operation.localeCompare(b.operation));
  }, [p.presets, q, onlyMachine, p.machine.name, p.machine.laser]);

  const save = (x: MaterialPreset) => {
    if (!x.material.trim()) return alert(t('lib.needMaterial'));
    const exists = p.presets.some((e) => e.id === x.id);
    p.setPresets(exists ? p.presets.map((e) => (e.id === x.id ? x : e)) : [...p.presets, x]);
    p.log(t('lib.saved', { name: presetLabel(x) }));
    setEditing(null);
    if (p.draft) p.onClose();
  };

  const remove = (x: MaterialPreset) => {
    if (confirm(t('lib.deleteConfirm', { name: presetLabel(x) }))) p.setPresets(p.presets.filter((e) => e.id !== x.id));
  };

  const doImport = async () => {
    const text = await window.laser.importLibrary();
    if (!text) return;
    try {
      const r = mergePresets(p.presets, normalizePresets(JSON.parse(text)));
      p.setPresets(r.presets);
      alert(t('lib.imported', { added: r.added, updated: r.updated }));
    } catch (e) {
      alert(e instanceof SyntaxError ? t('err.libraryInvalid') : errorText(e));
    }
  };

  const doExport = () => window.laser.exportLibrary(JSON.stringify({ app: 'craftlover-grbl', kind: 'materials', version: 1, presets: list }, null, 2));

  const newPreset = (): MaterialPreset => ({
    id: uid(),
    machine: p.machine.name,
    laser: p.machine.laser,
    material: '',
    thickness: 3,
    operation: '',
    mode: 'line',
    speed: 1000,
    power: 50,
    minPower: 0,
    passes: 1,
    lineInterval: 0.1,
    dither: 'floyd',
    threshold: 128,
    overscan: 2.5,
    bidirectional: true,
    notes: '',
  });

  return (
    <div className="modal-bg" onMouseDown={p.onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          📚 {t('lib.title')}
          {p.target && <span className="muted"> — {t('lib.applyTo', { name: p.target.name })}</span>}
        </h3>

        {editing ? (
          <PresetEditor value={editing} onSave={save} onCancel={() => (p.draft ? p.onClose() : setEditing(null))} isNew={!p.presets.some((e) => e.id === editing.id)} />
        ) : (
          <>
            <div className="row">
              <input placeholder={t('lib.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              <label className="chk">
                <input type="checkbox" checked={onlyMachine} onChange={(e) => setOnlyMachine(e.target.checked)} />
                {t('lib.thisMachine', { machine: p.machine.name || '—', laser: p.machine.laser || '—' })}
              </label>
            </div>
            <div className="lib-table">
              <table>
                <thead>
                  <tr>
                    <th>{t('lib.f.material')}</th>
                    <th>{t('lib.f.thickness')}</th>
                    <th>{t('lib.f.operation')}</th>
                    <th>{t('lp.mode')}</th>
                    <th>{t('lp.speed')}</th>
                    <th>{t('lp.power')}</th>
                    <th>{t('lp.passes')}</th>
                    {!onlyMachine && <th>{t('lib.f.machine')}</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((x) => (
                    <tr key={x.id} title={x.notes}>
                      <td>{x.material}</td>
                      <td>{x.thickness}</td>
                      <td>{x.operation}</td>
                      <td>{t(modeKey[x.mode])}</td>
                      <td>{x.speed}</td>
                      <td>{x.power}%</td>
                      <td>{x.passes}</td>
                      {!onlyMachine && (
                        <td className="muted">
                          {x.machine} · {x.laser}
                        </td>
                      )}
                      <td className="actions">
                        {p.target && p.onApply && (
                          <button
                            className="go"
                            // Image presets only fit image layers (and vector presets vector layers),
                            // otherwise the objects already on the layer would stop matching it
                            disabled={(x.mode === 'image') !== (p.target.mode === 'image')}
                            title={(x.mode === 'image') !== (p.target.mode === 'image') ? t('lib.modeMismatch') : undefined}
                            onClick={() => {
                              p.onApply!(x);
                              p.log(t('lib.applied', { name: presetLabel(x), layer: p.target!.name }));
                              p.onClose();
                            }}
                          >
                            {t('lib.apply')}
                          </button>
                        )}
                        <button title={t('lib.edit')} onClick={() => setEditing(x)}>✎</button>
                        <button title={t('lib.duplicate')} onClick={() => setEditing({ ...x, id: uid(), operation: `${x.operation} ${t('lib.copySuffix')}` })}>⧉</button>
                        <button title={t('lib.delete')} onClick={() => remove(x)}>🗑</button>
                      </td>
                    </tr>
                  ))}
                  {list.length === 0 && (
                    <tr>
                      <td colSpan={9} className="muted">
                        {t('lib.empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button onClick={() => setEditing(newPreset())}>＋ {t('lib.new')}</button>
              <button onClick={doImport}>⤒ {t('lib.import')}</button>
              <button onClick={doExport} disabled={!list.length}>⤓ {t('lib.export')}</button>
              <span className="spacer" />
              <button onClick={p.onClose}>{t('lib.close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PresetEditor({ value, onSave, onCancel, isNew }: { value: MaterialPreset; onSave: (p: MaterialPreset) => void; onCancel: () => void; isNew: boolean }) {
  const [v, setV] = useState(value);
  const set = (patch: Partial<MaterialPreset>) => setV((o) => ({ ...o, ...patch }));
  return (
    <>
      <h4>{isNew ? t('lib.newTitle') : t('lib.editTitle')}</h4>
      <div className="grid4 editor">
        <label>{t('lib.f.machine')}</label>
        <input value={v.machine} onChange={(e) => set({ machine: e.target.value })} />
        <label>{t('lib.f.laser')}</label>
        <input value={v.laser} onChange={(e) => set({ laser: e.target.value })} />
        <label>{t('lib.f.material')}</label>
        <input value={v.material} onChange={(e) => set({ material: e.target.value })} autoFocus />
        <label>{t('lib.f.thickness')}</label>
        <NumField value={v.thickness} min={0} step={0.5} onCommit={(n) => set({ thickness: n })} />
        <label>{t('lib.f.operation')}</label>
        <input value={v.operation} onChange={(e) => set({ operation: e.target.value })} />
        <label>{t('lp.mode')}</label>
        <select value={v.mode} onChange={(e) => set({ mode: e.target.value as MaterialPreset['mode'] })}>
          <option value="line">{t('mode.line')}</option>
          <option value="fill">{t('mode.fill')}</option>
          <option value="image">{t('mode.image')}</option>
        </select>
        <label>{t('lp.speed')}</label>
        <NumField value={v.speed} min={1} step={10} onCommit={(n) => set({ speed: n })} />
        <label>{t('lp.power')}</label>
        <NumField value={v.power} min={0} step={1} onCommit={(n) => set({ power: Math.min(100, n) })} />
        <label>{t('lp.passes')}</label>
        <NumField value={v.passes} min={1} step={1} onCommit={(n) => set({ passes: Math.max(1, Math.round(n)) })} />
        {v.mode !== 'line' && (
          <>
            <label>{t('lp.interval')}</label>
            <NumField value={v.lineInterval} min={0.03} step={0.01} onCommit={(n) => set({ lineInterval: n })} />
          </>
        )}
        {v.mode === 'image' && (
          <>
            <label>{t('lp.dither')}</label>
            <select value={v.dither} onChange={(e) => set({ dither: e.target.value as MaterialPreset['dither'] })}>
              <option value="floyd">{t('dither.floyd')}</option>
              <option value="threshold">{t('dither.threshold')}</option>
              <option value="grayscale">{t('dither.grayscale')}</option>
            </select>
          </>
        )}
      </div>
      <label className="muted">{t('lib.f.notes')}</label>
      <textarea rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onCancel}>{t('common.cancel')}</button>
        <button className="go" onClick={() => onSave(v)}>
          {t('lib.save')}
        </button>
      </div>
    </>
  );
}
