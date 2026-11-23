import { useEffect, useMemo, useState } from 'react';
import type { Anchor, Item, JobOptions, Layer, MachineProfile, OriginMode } from '../core/types';
import { itemBounds, uid } from '../core/geometry';
import { frameGcode, generateJob, jobBounds } from '../core/gcode';
import { importSvg } from '../io/svg';
import { importPdf, importRaster } from '../io/image';
import { textToPaths, type TextAlign } from '../io/text';
import { parseProject, serializeProject } from '../io/project';
import { traceBitmap, type TraceOptions } from '../core/trace';
import { transformItem } from '../core/transform';
import { useGrbl, type PortInfo } from '../machine/useGrbl';
import { Workspace } from './Workspace';
import { TextDialog } from './TextDialog';

const DEFAULT_MACHINE: MachineProfile = {
  bedW: 410,
  bedH: 400,
  sMax: 1000,
  baud: 115200,
  frameSpeed: 3000,
  framePower: 1,
  travelSpeed: 6000,
};

const baseLayer = { minPower: 0, passes: 1, lineInterval: 0.1, dither: 'floyd' as const, threshold: 128, overscan: 2.5, bidirectional: true, enabled: true };
const DEFAULT_LAYERS: Layer[] = [
  { ...baseLayer, id: 'cut', name: 'Cắt', color: '#e5243b', mode: 'line', speed: 300, power: 100 },
  { ...baseLayer, id: 'score', name: 'Khắc nét', color: '#2f7cf6', mode: 'line', speed: 3000, power: 30 },
  { ...baseLayer, id: 'fill', name: 'Khắc tô', color: '#18a058', mode: 'fill', speed: 6000, power: 40 },
  { ...baseLayer, id: 'image', name: 'Khắc ảnh', color: '#333333', mode: 'image', speed: 3000, power: 50 },
];

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...d, ...JSON.parse(v) } : d;
  } catch {
    return d;
  }
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} giờ ${m % 60} phút` : `${m} phút ${Math.round(s % 60)} giây`;
};

export function App() {
  const g = useGrbl();
  const [machine, setMachine] = useState<MachineProfile>(() => load('machine', DEFAULT_MACHINE));
  const [layers, setLayers] = useState<Layer[]>(() => {
    try {
      const v = localStorage.getItem('layers');
      return v ? JSON.parse(v) : DEFAULT_LAYERS;
    } catch {
      return DEFAULT_LAYERS;
    }
  });
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [originMode, setOriginMode] = useState<OriginMode>('absolute');
  const [anchor, setAnchor] = useState<Anchor>('bl');
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => localStorage.setItem('machine', JSON.stringify(machine)), [machine]);
  useEffect(() => localStorage.setItem('layers', JSON.stringify(layers)), [layers]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const patchItem = (id: string, patch: Partial<Item>) => setItems((a) => a.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const patchLayer = (id: string, patch: Partial<Layer>) => setLayers((a) => a.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const jobOpt: JobOptions = { originMode, anchor, currentPos: g.status.wpos };
  const running = !!g.progress?.running;

  const job = useMemo(() => {
    if (!showPreview || items.length === 0) return null;
    try {
      return generateJob(items, layers, machine, jobOpt);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPreview, items, layers, machine, originMode, anchor, originMode === 'current' ? g.status.wpos : null]);

  async function importFiles(given?: { name: string; data: Uint8Array }[]) {
    const files = given ?? (await window.laser.openFiles());
    for (const f of files) {
      const ext = f.name.split('.').pop()!.toLowerCase();
      setBusy(`Đang nhập ${f.name}…`);
      try {
        const add = (it: Omit<Item, 'id' | 'x' | 'y' | 'copies'>) => {
          const id = uid();
          setItems((a) => {
            // Đặt đối tượng mới bên phải các đối tượng đã có (nếu còn chỗ trên bàn)
            const right = a.reduce((m, i) => Math.max(m, itemBounds(i).maxX), 0);
            const x = a.length && right + 5 + it.w <= machine.bedW ? right + 5 : 10;
            return [...a, { ...it, id, x, y: 10, copies: { cols: 1, rows: 1, gapX: 5, gapY: 5 } }];
          });
          setSelectedId(id);
        };
        if (ext === 'svg') {
          const r = importSvg(new TextDecoder().decode(f.data));
          add({ name: f.name, kind: 'vector', paths: r.paths, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: 'cut' });
        } else if (ext === 'pdf' || ext === 'ai' || ext === 'eps') {
          // EPS được Ghostscript chuyển sang PDF (giữ nguyên vector) rồi đọc như PDF
          const pdf = ext === 'eps' ? await window.laser.epsToPdf(f.data) : f.data;
          const pages = await importPdf(pdf);
          pages.forEach((pg, i) => {
            const base = pages.length > 1 ? `${f.name} (trang ${i + 1})` : f.name;
            const v = pg.vector;
            if (v.paths.length) add({ name: base, kind: 'vector', paths: v.paths, srcW: v.w, srcH: v.h, w: v.w, h: v.h, layerId: 'cut' });
            if (pg.raster) {
              const r = pg.raster;
              add({ name: `${base} (ảnh)`, kind: 'bitmap', bitmap: r.bitmap, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: 'image' });
              if (v.paths.length)
                g.push(`${base}: có chữ/ảnh không chuyển được thành đường cắt → đã nhập thêm bản ảnh để khắc. Muốn cắt chữ, hãy chuyển chữ thành đường cong (Create Outlines) trong phần mềm thiết kế.`);
            }
          });
        } else {
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          const r = await importRaster(f.data, mime);
          add({ name: f.name, kind: 'bitmap', bitmap: r.bitmap, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: 'image' });
        }
        g.push(`Đã nhập ${f.name}`);
      } catch (e) {
        g.push(`Lỗi nhập ${f.name}: ${(e as Error).message}`);
        if (!given) alert(`Không nhập được ${f.name}:\n${(e as Error).message}`);
      }
    }
    setBusy('');
  }

  function addItem(it: Omit<Item, 'id' | 'x' | 'y' | 'copies'>, at?: { x: number; y: number }) {
    const id = uid();
    setItems((a) => [...a, { ...it, id, x: at?.x ?? 10, y: at?.y ?? 10, copies: { cols: 1, rows: 1, gapX: 5, gapY: 5 } }]);
    setSelectedId(id);
    return id;
  }

  function applyTransform(angle: number, fx = false, fy = false) {
    if (!selected) return;
    setItems((a) => a.map((i) => (i.id === selected.id ? transformItem(i, angle, fx, fy) : i)));
  }

  function traceSelected(opt: TraceOptions) {
    if (!selected?.bitmap) return;
    const paths = traceBitmap(selected.bitmap, selected.w, selected.h, opt);
    if (!paths.length) return alert('Không tìm thấy vùng tối nào — hãy tăng ngưỡng');
    addItem(
      { name: `Viền: ${selected.name}`, kind: 'vector', paths, srcW: selected.w, srcH: selected.h, w: selected.w, h: selected.h, layerId: 'cut' },
      selected,
    );
    g.push(`Dò viền được ${paths.length} đường từ ${selected.name}`);
  }

  function duplicateSelected() {
    if (!selected) return;
    const b = itemBounds(selected);
    addItem({ ...selected, name: `${selected.name} (bản sao)` }, { x: b.maxX + 5, y: selected.y });
  }

  async function addText(t: { text: string; font: string; size: number; align: TextAlign; layerId: string }) {
    const r = await textToPaths(t.text, t.font, t.size, t.align);
    addItem({ name: `Chữ: ${t.text.split('\n')[0].slice(0, 20)}`, kind: 'vector', paths: r.paths, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: t.layerId });
  }

  async function saveProject() {
    await window.laser.saveText('du-an.lzr', serializeProject(items, layers), 'project');
  }

  async function openProject() {
    const f = await window.laser.openProject();
    if (!f) return;
    try {
      const p = parseProject(f.text);
      setItems(p.items);
      setLayers(p.layers);
      setSelectedId(null);
      g.push(`Đã mở dự án ${f.name}`);
    } catch (e) {
      alert(`Không mở được dự án: ${(e as Error).message}`);
    }
  }

  // Phím tắt: Delete xóa, mũi tên dịch 1 mm (Shift: 10 mm), Ctrl+D nhân đôi
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !selectedId) return;
      const step = e.shiftKey ? 10 : 1;
      const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (e.key === 'Delete') {
        setItems((a) => a.filter((i) => i.id !== selectedId));
        setSelectedId(null);
      } else if (mv[e.key]) {
        e.preventDefault();
        setItems((a) => a.map((i) => (i.id === selectedId ? { ...i, x: i.x + mv[e.key][0], y: i.y + mv[e.key][1] } : i)));
      } else if (e.ctrlKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const [textOpen, setTextOpen] = useState(false);

  // Móc kiểm thử dùng cho chế độ chụp màn hình tự động
  (window as any).__laserAction = async (name: string, ...args: any[]) => {
    if (name === 'select') setSelectedId(items[args[0]]?.id ?? null);
    if (name === 'preview') setShowPreview(!!args[0]);
    if (name === 'rotate') applyTransform(args[0], args[1], args[2]);
    if (name === 'trace') traceSelected({ threshold: 128, minArea: 0.5, smooth: 0.8 });
    if (name === 'text') await addText({ text: args[0], font: args[1], size: args[2], align: 'center', layerId: 'fill' });
    if (name === 'move') setItems((a) => a.map((i, k) => (k === args[0] ? { ...i, x: args[1], y: args[2] } : i)));
    if (name === 'roundtrip') {
      const p = parseProject(serializeProject(items, layers));
      setItems(p.items);
      return p.items.length;
    }
    if (name === 'fonts') return (await window.laser.listFonts()).slice(0, 3);
    return items.map((i) => `${i.name} | ${i.kind} ${i.w.toFixed(1)}x${i.h.toFixed(1)} @${i.x.toFixed(1)},${i.y.toFixed(1)} paths=${i.paths?.length ?? 0}`).join('\n');
  };
  // Móc kiểm thử: cho phép tiến trình chính nạp file mẫu khi chụp màn hình tự động
  (window as any).__laserImport = (files: { name: string; b64: string }[], preview = true) => {
    setShowPreview(preview);
    return importFiles(files.map((f) => ({ name: f.name, data: Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) })));
  };
  (window as any).__laserGcode = () => generateJob(items, layers, machine, jobOpt).lines.join('\n');
  (window as any).__laserSetCopies = (cols: number, rows: number) =>
    setItems((a) => a.map((i, k) => (k === 0 ? { ...i, copies: { ...i.copies, cols, rows } } : i)));

  function buildJob() {
    if (items.length === 0) throw new Error('Chưa có đối tượng nào');
    const b = jobBounds(items, jobOpt);
    if (b.minX < -0.01 || b.minY < -0.01 || b.maxX > machine.bedW + 0.01 || b.maxY > machine.bedH + 0.01)
      if (!confirm(`Vùng cắt (${b.minX.toFixed(1)},${b.minY.toFixed(1)}) → (${b.maxX.toFixed(1)},${b.maxY.toFixed(1)}) vượt ra ngoài bàn máy ${machine.bedW}×${machine.bedH} mm. Vẫn tiếp tục?`))
        return null;
    return generateJob(items, layers, machine, jobOpt);
  }

  async function exportGcode() {
    try {
      const j = buildJob();
      if (j) await window.laser.saveText('job.gcode', j.lines.join('\n') + '\n');
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function startJob() {
    try {
      const j = buildJob();
      if (!j) return;
      if (!confirm(`Bắt đầu chạy ${j.lines.length} dòng lệnh (ước tính ${fmtTime(j.seconds)})?\nHãy đeo kính bảo hộ và kiểm tra phôi.`)) return;
      await window.laser.run(j.lines);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function runFrame() {
    const lines = frameGcode(items, machine, jobOpt);
    if (!lines.length) return alert('Chưa có đối tượng nào để chạy khung');
    await g.send(lines);
  }

  const jog = (dx: number, dy: number, step: number, feed: number) =>
    g.send(`$J=G91 G21 X${(dx * step).toFixed(3)} Y${(dy * step).toFixed(3)} F${feed}`);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">⚡ Laser Tool</strong>
        <button onClick={openProject} title="Mở dự án .lzr">📁 Mở</button>
        <button onClick={saveProject} disabled={!items.length} title="Lưu dự án .lzr">💾 Lưu dự án</button>
        <button onClick={() => importFiles()}>📥 Nhập file</button>
        <button onClick={() => setTextOpen(true)}>🔤 Chữ</button>
        <button onClick={duplicateSelected} disabled={!selected} title="Ctrl+D">⧉ Nhân đôi</button>
        <button onClick={() => selected && (setItems((a) => a.filter((i) => i.id !== selected.id)), setSelectedId(null))} disabled={!selected}>
          🗑 Xóa
        </button>
        <label className="chk">
          <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} /> Xem đường chạy
        </label>
        {job && <span className="muted">≈ {fmtTime(job.seconds)} · {job.lines.length} dòng</span>}
        <span className="spacer" />
        <button onClick={exportGcode} disabled={!items.length}>⤓ Xuất G-code</button>
        <button className="warn" onClick={runFrame} disabled={!g.connected || running || !items.length} title="Chạy khung bao vùng cắt với công suất thấp">
          ⬚ Chạy khung
        </button>
        <button className="go" onClick={startJob} disabled={!g.connected || running || !items.length}>▶ Bắt đầu</button>
        {running && !g.progress?.paused && <button onClick={() => window.laser.pause()}>⏸ Tạm dừng</button>}
        {running && g.progress?.paused && <button onClick={() => window.laser.resume()}>⏵ Tiếp tục</button>}
        <button className="stop" onClick={() => window.laser.abort()} disabled={!g.connected}>■ DỪNG</button>
      </header>

      <main className="main">
        <Workspace
          bedW={machine.bedW}
          bedH={machine.bedH}
          items={items}
          layers={layers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChange={patchItem}
          laserPos={g.connected ? g.status.wpos : null}
          jobFrame={originMode === 'current' && items.length ? jobBounds(items, jobOpt) : null}
          preview={job?.preview ?? null}
        />
        <aside className="side">
          <ConnectionPanel g={g} machine={machine} setMachine={setMachine} />
          <JogPanel g={g} jog={jog} disabled={!g.connected || running} />
          <JobPanel originMode={originMode} setOriginMode={setOriginMode} anchor={anchor} setAnchor={setAnchor} machine={machine} setMachine={setMachine} />
          {selected && <ItemPanel item={selected} layers={layers} patch={(p) => patchItem(selected.id, p)} onTransform={applyTransform} onTrace={traceSelected} />}
          <LayersPanel layers={layers} patch={patchLayer} reset={() => setLayers(DEFAULT_LAYERS)} />
        </aside>
      </main>

      {textOpen && (
        <TextDialog
          layers={layers}
          onClose={() => setTextOpen(false)}
          onOk={async (t) => {
            try {
              await addText(t);
              setTextOpen(false);
            } catch (e) {
              alert((e as Error).message);
            }
          }}
        />
      )}

      <footer className="status">
        <span className={`dot ${g.connected ? 'on' : ''}`} /> {g.connected ? g.status.state : 'Chưa kết nối'}
        <span>X {g.status.wpos.x.toFixed(2)}</span>
        <span>Y {g.status.wpos.y.toFixed(2)}</span>
        {g.progress && g.progress.total > 0 && (
          <span>
            Tiến độ: {Math.round((100 * g.progress.acked) / g.progress.total)}% ({g.progress.acked}/{g.progress.total})
            {g.progress.errors > 0 && ` · ${g.progress.errors} lỗi`}
          </span>
        )}
        {busy && <span>{busy}</span>}
        <span className="spacer" />
        <span className="muted">{g.version}</span>
      </footer>
    </div>
  );
}

type G = ReturnType<typeof useGrbl>;

function ConnectionPanel({ g, machine, setMachine }: { g: G; machine: MachineProfile; setMachine: (m: MachineProfile) => void }) {
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
      <h3>Kết nối máy</h3>
      <div className="row">
        <select value={port} onChange={(e) => setPort(e.target.value)} disabled={g.connected}>
          {ports.length === 0 && <option value="">(không thấy cổng COM)</option>}
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path} {p.friendlyName || p.manufacturer}
            </option>
          ))}
        </select>
        <button onClick={refresh} disabled={g.connected} title="Quét lại cổng">⟳</button>
      </div>
      <div className="row">
        <select value={machine.baud} onChange={(e) => setMachine({ ...machine, baud: +e.target.value })} disabled={g.connected}>
          {[115200, 250000, 57600, 9600].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        {g.connected ? (
          <button onClick={g.disconnect}>Ngắt kết nối</button>
        ) : (
          <button className="go" disabled={!port} onClick={() => g.connect(port, machine.baud).catch((e) => alert(`Không mở được cổng: ${e.message}`))}>
            Kết nối
          </button>
        )}
      </div>
      <div className="console">
        {g.log.slice(-80).reverse().map((l, i) => (
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
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Gõ lệnh G-code / $$ …" disabled={!g.connected} />
        <button disabled={!g.connected}>Gửi</button>
      </form>
    </section>
  );
}

function JogPanel({ g, jog, disabled }: { g: G; jog: (dx: number, dy: number, step: number, feed: number) => void; disabled: boolean }) {
  const [step, setStep] = useState(10);
  const [feed, setFeed] = useState(3000);
  const [firing, setFiring] = useState(false);
  const fire = async () => {
    if (firing) {
      await g.send(['M5 S0']);
      setFiring(false);
    } else {
      // Bật tia rất yếu (1%) để nhìn vị trí — không để lâu một chỗ
      await g.send(['M3 S10', 'G1 F1000']);
      setFiring(true);
    }
  };
  return (
    <section className="panel">
      <h3>Điều khiển & gốc tọa độ</h3>
      <div className="jog">
        <span />
        <button disabled={disabled} onClick={() => jog(0, 1, step, feed)}>▲ Y+</button>
        <span />
        <button disabled={disabled} onClick={() => jog(-1, 0, step, feed)}>◀ X−</button>
        <button disabled={disabled} onClick={() => g.send('G90 G0 X0 Y0')} title="Về gốc làm việc">⌂</button>
        <button disabled={disabled} onClick={() => jog(1, 0, step, feed)}>X+ ▶</button>
        <span />
        <button disabled={disabled} onClick={() => jog(0, -1, step, feed)}>▼ Y−</button>
        <span />
      </div>
      <div className="row">
        <label>Bước</label>
        {[0.1, 1, 10, 50].map((s) => (
          <button key={s} className={s === step ? 'sel' : ''} onClick={() => setStep(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className="row">
        <label>Tốc độ jog</label>
        <input type="number" value={feed} onChange={(e) => setFeed(+e.target.value)} />
      </div>
      <div className="row wrap">
        <button disabled={disabled} onClick={() => g.send('G10 L20 P1 X0 Y0')} title="Lấy vị trí hiện tại của đầu laser làm gốc (0,0)">
          📍 Đặt gốc tại đây
        </button>
        <button disabled={disabled} onClick={() => g.send('$H')} title="Chạy về công tắc hành trình (nếu máy có lắp)">Homing</button>
        <button disabled={!g.connected} onClick={() => g.send('$X')} title="Mở khóa sau báo động">Mở khóa $X</button>
        <button disabled={disabled} className={firing ? 'warn' : ''} onClick={fire} title="Bật tia công suất 1% để căn chỉnh">
          {firing ? '🔴 Tắt tia' : '🔆 Bắn tia 1%'}
        </button>
      </div>
    </section>
  );
}

const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

function JobPanel(p: {
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
      <h3>Công việc</h3>
      <div className="row">
        <select value={p.originMode} onChange={(e) => p.setOriginMode(e.target.value as OriginMode)}>
          <option value="absolute">Theo gốc làm việc (vị trí trên bàn)</option>
          <option value="current">Từ vị trí đầu laser hiện tại</option>
        </select>
      </div>
      {p.originMode === 'current' && (
        <div className="row">
          <label>Điểm neo</label>
          <div className="anchors">
            {ANCHORS.map((a) => (
              <button key={a} className={a === p.anchor ? 'sel' : ''} onClick={() => p.setAnchor(a)} />
            ))}
          </div>
        </div>
      )}
      <div className="grid2">
        <label>Tốc độ chạy khung</label>
        <input type="number" value={m.frameSpeed} onChange={(e) => p.setMachine({ ...m, frameSpeed: +e.target.value })} />
        <label>Công suất khung (%)</label>
        <input type="number" step={0.5} min={0} max={5} value={m.framePower} onChange={(e) => p.setMachine({ ...m, framePower: Math.min(5, +e.target.value) })} />
        <label>Bàn máy W×H (mm)</label>
        <div className="row">
          <input type="number" value={m.bedW} onChange={(e) => p.setMachine({ ...m, bedW: +e.target.value })} />
          <input type="number" value={m.bedH} onChange={(e) => p.setMachine({ ...m, bedH: +e.target.value })} />
        </div>
        <label>S max ($30)</label>
        <input type="number" value={m.sMax} onChange={(e) => p.setMachine({ ...m, sMax: +e.target.value })} />
      </div>
    </section>
  );
}

function ItemPanel({
  item,
  layers,
  patch,
  onTransform,
  onTrace,
}: {
  item: Item;
  layers: Layer[];
  patch: (p: Partial<Item>) => void;
  onTransform: (angle: number, fx?: boolean, fy?: boolean) => void;
  onTrace: (o: TraceOptions) => void;
}) {
  const [lock, setLock] = useState(true);
  const [angle, setAngle] = useState(15);
  const [th, setTh] = useState(128);
  const [smooth, setSmooth] = useState(0.8);
  const ratio = item.h / item.w;
  const num = (v: number) => Math.round(v * 100) / 100;
  return (
    <section className="panel">
      <h3 title={item.name}>Đối tượng: {item.name}</h3>
      <div className="grid4">
        <label>X</label>
        <input type="number" step={0.5} value={num(item.x)} onChange={(e) => patch({ x: +e.target.value })} />
        <label>Y</label>
        <input type="number" step={0.5} value={num(item.y)} onChange={(e) => patch({ y: +e.target.value })} />
        <label>Rộng</label>
        <input type="number" step={0.5} value={num(item.w)} onChange={(e) => +e.target.value > 0 && patch(lock ? { w: +e.target.value, h: +e.target.value * ratio } : { w: +e.target.value })} />
        <label>Cao</label>
        <input type="number" step={0.5} value={num(item.h)} onChange={(e) => +e.target.value > 0 && patch(lock ? { h: +e.target.value, w: +e.target.value / ratio } : { h: +e.target.value })} />
      </div>
      <div className="row">
        <label className="chk">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Giữ tỉ lệ
        </label>
        <button onClick={() => patch({ w: item.srcW, h: item.srcH })}>Cỡ gốc</button>
      </div>
      <div className="row">
        <label>Lớp</label>
        <select value={item.layerId} onChange={(e) => patch({ layerId: e.target.value })}>
          {layers
            .filter((l) => item.kind === 'vector' || l.mode === 'image')
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </div>
      <h4>Xoay / lật</h4>
      <div className="row wrap">
        <button onClick={() => onTransform(90)} title="Xoay 90° ngược chiều kim đồng hồ">⟲ 90°</button>
        <button onClick={() => onTransform(-90)} title="Xoay 90° theo chiều kim đồng hồ">⟳ 90°</button>
        <button onClick={() => onTransform(0, true, false)}>⇋ Lật ngang</button>
        <button onClick={() => onTransform(0, false, true)}>⇵ Lật dọc</button>
      </div>
      <div className="row">
        <label>Góc (°)</label>
        <input type="number" value={angle} onChange={(e) => setAngle(+e.target.value)} />
        <button onClick={() => onTransform(angle)}>Xoay</button>
      </div>
      {item.kind === 'bitmap' && (
        <>
          <h4>Dò viền ảnh → đường cắt</h4>
          <div className="row">
            <label>Ngưỡng</label>
            <input type="range" min={1} max={254} value={th} onChange={(e) => setTh(+e.target.value)} />
            <span className="muted">{th}</span>
          </div>
          <div className="row">
            <label>Làm mượt</label>
            <input type="range" min={0} max={3} step={0.1} value={smooth} onChange={(e) => setSmooth(+e.target.value)} />
            <span className="muted">{smooth}</span>
          </div>
          <button onClick={() => onTrace({ threshold: th, minArea: 0.5, smooth })}>✎ Dò viền</button>
        </>
      )}
      <h4>Nhân bản (cắt nhiều sản phẩm)</h4>
      <div className="grid4">
        <label>Cột</label>
        <input type="number" min={1} value={item.copies.cols} onChange={(e) => patch({ copies: { ...item.copies, cols: Math.max(1, Math.floor(+e.target.value)) } })} />
        <label>Hàng</label>
        <input type="number" min={1} value={item.copies.rows} onChange={(e) => patch({ copies: { ...item.copies, rows: Math.max(1, Math.floor(+e.target.value)) } })} />
        <label>Cách X</label>
        <input type="number" step={0.5} value={item.copies.gapX} onChange={(e) => patch({ copies: { ...item.copies, gapX: +e.target.value } })} />
        <label>Cách Y</label>
        <input type="number" step={0.5} value={item.copies.gapY} onChange={(e) => patch({ copies: { ...item.copies, gapY: +e.target.value } })} />
      </div>
      <div className="muted">Tổng: {item.copies.cols * item.copies.rows} sản phẩm</div>
    </section>
  );
}

function LayersPanel({ layers, patch, reset }: { layers: Layer[]; patch: (id: string, p: Partial<Layer>) => void; reset: () => void }) {
  const [open, setOpen] = useState<string | null>('cut');
  return (
    <section className="panel">
      <h3>
        Lớp gia công <button className="tiny" onClick={reset}>Mặc định</button>
      </h3>
      {layers.map((l) => (
        <div key={l.id} className="layer">
          <div className="layer-head" onClick={() => setOpen(open === l.id ? null : l.id)}>
            <input type="checkbox" checked={l.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => patch(l.id, { enabled: e.target.checked })} />
            <span className="swatch" style={{ background: l.color }} />
            <b>{l.name}</b>
            <span className="muted">
              {l.speed} mm/ph · {l.power}% · x{l.passes}
            </span>
          </div>
          {open === l.id && (
            <div className="grid2">
              <label>Tên</label>
              <input value={l.name} onChange={(e) => patch(l.id, { name: e.target.value })} />
              <label>Chế độ</label>
              <select value={l.mode} onChange={(e) => patch(l.id, { mode: e.target.value as Layer['mode'] })}>
                <option value="line">Cắt / vạch theo nét</option>
                <option value="fill">Khắc tô kín vector</option>
                <option value="image">Khắc ảnh</option>
              </select>
              <label>Tốc độ (mm/ph)</label>
              <input type="number" value={l.speed} onChange={(e) => patch(l.id, { speed: Math.max(1, +e.target.value) })} />
              <label>Công suất (%)</label>
              <input type="number" min={0} max={100} value={l.power} onChange={(e) => patch(l.id, { power: Math.min(100, Math.max(0, +e.target.value)) })} />
              <label>Số lượt</label>
              <input type="number" min={1} value={l.passes} onChange={(e) => patch(l.id, { passes: Math.max(1, Math.floor(+e.target.value)) })} />
              {l.mode !== 'line' && (
                <>
                  <label>Khoảng dòng (mm)</label>
                  <input type="number" step={0.01} min={0.03} value={l.lineInterval} onChange={(e) => patch(l.id, { lineInterval: Math.max(0.03, +e.target.value) })} />
                  <label>Đi quá biên (mm)</label>
                  <input type="number" step={0.5} min={0} value={l.overscan} onChange={(e) => patch(l.id, { overscan: Math.max(0, +e.target.value) })} />
                  <label>Quét 2 chiều</label>
                  <input type="checkbox" checked={l.bidirectional} onChange={(e) => patch(l.id, { bidirectional: e.target.checked })} />
                </>
              )}
              {l.mode === 'image' && (
                <>
                  <label>Xử lý ảnh</label>
                  <select value={l.dither} onChange={(e) => patch(l.id, { dither: e.target.value as Layer['dither'] })}>
                    <option value="floyd">Floyd–Steinberg (chấm)</option>
                    <option value="threshold">Đen trắng (ngưỡng)</option>
                    <option value="grayscale">Thang xám (đổi công suất)</option>
                  </select>
                  {l.dither === 'threshold' && (
                    <>
                      <label>Ngưỡng</label>
                      <input type="range" min={1} max={254} value={l.threshold} onChange={(e) => patch(l.id, { threshold: +e.target.value })} />
                    </>
                  )}
                  {l.dither === 'grayscale' && (
                    <>
                      <label>Công suất min (%)</label>
                      <input type="number" min={0} max={l.power} value={l.minPower} onChange={(e) => patch(l.id, { minPower: +e.target.value })} />
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
