import { useEffect, useState } from 'react';
import type { Layer } from '../core/types';
import type { TextAlign } from '../io/text';

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
  const [text, setText] = useState('Xin chào');
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
        <h3>Thêm chữ</h3>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="grid2">
          <label>Font</label>
          <select value={font} onChange={(e) => setFont(e.target.value)}>
            {fonts.length === 0 && <option value="">(đang tải…)</option>}
            {fonts.map((f) => (
              <option key={f.file} value={f.file}>
                {f.name}
              </option>
            ))}
          </select>
          <label>Cỡ chữ (mm)</label>
          <input type="number" min={1} step={0.5} value={size} onChange={(e) => setSize(Math.max(1, +e.target.value))} />
          <label>Căn lề</label>
          <select value={align} onChange={(e) => setAlign(e.target.value as TextAlign)}>
            <option value="left">Trái</option>
            <option value="center">Giữa</option>
            <option value="right">Phải</option>
          </select>
          <label>Lớp</label>
          <select value={layerId} onChange={(e) => setLayerId(e.target.value)}>
            {vec.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Hủy</button>
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
            Thêm
          </button>
        </div>
      </div>
    </div>
  );
}
