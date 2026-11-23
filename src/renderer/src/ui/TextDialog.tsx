import { useEffect, useState } from 'react';
import type { Layer } from '../core/types';
import type { TextAlign } from '../io/text';
import { t } from '../i18n';

export interface TextSpec {
  text: string;
  font: string;
  size: number;
  align: TextAlign;
  layerId: string;
}

export function TextDialog({ layers, defaultLayerId, onClose, onOk }: { layers: Layer[]; defaultLayerId?: string; onClose: () => void; onOk: (t: TextSpec) => Promise<void> | void }) {
  const [fonts, setFonts] = useState<{ name: string; file: string }[]>([]);
  const [font, setFont] = useState(() => localStorage.getItem('font') ?? '');
  const [text, setText] = useState(() => t('textdlg.default'));
  const [size, setSize] = useState(20);
  const [align, setAlign] = useState<TextAlign>('center');
  const vec = layers.filter((l) => l.mode !== 'image');
  const [layerId, setLayerId] = useState(defaultLayerId ?? vec.find((l) => l.mode === 'fill')?.id ?? vec[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.laser.listFonts().then((l) => {
      setFonts(l);
      setFont((cur) => (l.some((f) => f.file === cur) ? cur : (l.find((f) => f.name === 'Arial')?.file ?? l[0]?.file ?? '')));
    });
  }, []);

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('textdlg.title')}</h3>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="grid2">
          <label>{t('textdlg.font')}</label>
          <select value={font} onChange={(e) => setFont(e.target.value)}>
            {fonts.length === 0 && <option value="">{t('textdlg.loading')}</option>}
            {fonts.map((f) => (
              <option key={f.file} value={f.file}>
                {f.name}
              </option>
            ))}
          </select>
          <label>{t('textdlg.size')}</label>
          <input type="number" min={1} step={0.5} value={size} onChange={(e) => setSize(Math.max(1, +e.target.value))} />
          <label>{t('textdlg.align')}</label>
          <select value={align} onChange={(e) => setAlign(e.target.value as TextAlign)}>
            <option value="left">{t('textdlg.left')}</option>
            <option value="center">{t('textdlg.center')}</option>
            <option value="right">{t('textdlg.right')}</option>
          </select>
          <label>{t('textdlg.layer')}</label>
          <select value={layerId} onChange={(e) => setLayerId(e.target.value)}>
            {vec.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="go"
            disabled={!text.trim() || !font || busy}
            onClick={async () => {
              setBusy(true);
              localStorage.setItem('font', font);
              try {
                await onOk({ text, font, size, align, layerId });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('common.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
