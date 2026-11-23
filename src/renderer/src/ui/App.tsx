import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, Item, JobOptions, Layer, MachineProfile, OriginMode, Pt } from '../core/types';
import { itemBounds, uid } from '../core/geometry';
import { frameGcode, generateJob, jobBounds } from '../core/gcode';
import { importSvg } from '../io/svg';
import { importPdf, importRaster } from '../io/image';
import { textToPaths, type TextAlign } from '../io/text';
import { parseProject, serializeProject } from '../io/project';
import { traceBitmap, type TraceOptions } from '../core/trace';
import { useGrbl, type PortInfo } from '../machine/useGrbl';
import { Workspace, type NewItem, type Tool } from './Workspace';
import { TextDialog } from './TextDialog';
import { useHistory } from './useHistory';
import { NumField, Palette, PropertyBar, ToolBar, type PropertyActions } from './DesignBars';
import { alignItems, cloneItems, distributeItems, flipItems, moveItems, rotateItems, scaleItems, selBounds } from './designOps';
import { shapePaths } from '../core/shapes';

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
  // Danh sách đối tượng có hoàn tác/làm lại (Ctrl+Z / Ctrl+Y)
  const hist = useHistory<Item[]>([]);
  const items = hist.state;
  const setItems = hist.commit;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const setSelectedId = (id: string | null) => setSelectedIds(id ? [id] : []);
  const [tool, setTool] = useState<Tool>('select');
  const [sides, setSides] = useState(6);
  const [activeLayerId, setActiveLayerId] = useState('cut');
  const [textAt, setTextAt] = useState<Pt | null>(null);
  const clipboard = useRef<Item[]>([]);
  const [originMode, setOriginMode] = useState<OriginMode>('absolute');
  const [anchor, setAnchor] = useState<Anchor>('bl');
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => localStorage.setItem('machine', JSON.stringify(machine)), [machine]);
  useEffect(() => localStorage.setItem('layers', JSON.stringify(layers)), [layers]);

  const selSet = new Set(selectedIds);
  const selItems = items.filter((i) => selSet.has(i.id));
  const selected = selItems.length === 1 ? selItems[0] : null;
  const patchItem = (id: string, patch: Partial<Item>) => setItems((a) => a.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? layers[0];

  // Bỏ chọn các đối tượng đã bị xóa (vd. sau khi hoàn tác)
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    if (selectedIds.some((id) => !ids.has(id))) setSelectedIds((s) => s.filter((id) => ids.has(id)));
  }, [items, selectedIds]);
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

  function createDrawn(it: NewItem) {
    const id = uid();
    setItems((a) => [...a, { ...it, id, copies: { cols: 1, rows: 1, gapX: 5, gapY: 5 } }]);
    setSelectedId(id);
  }

  function applyTransform(angle: number, fx = false, fy = false) {
    if (!selItems.length) return;
    if (fx || fy) setItems((a) => flipItems(a, selSet, fx, fy));
    else {
      const b = selBounds(selItems);
      setItems((a) => rotateItems(a, selSet, angle, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }));
    }
  }

  /** Nhấp một màu trong bảng màu: gán đối tượng đang chọn vào lớp màu đó (tạo lớp mới nếu chưa có). */
  function pickColor(color: string) {
    let layer = layers.find((l) => l.color.toLowerCase() === color);
    if (!layer) {
      layer = { ...baseLayer, id: uid(), name: `Lớp ${layers.length + 1}`, color, mode: 'line', speed: 1000, power: 20 };
      const nl = layer;
      setLayers((a) => [...a, nl]);
    }
    const target = layer;
    if (!selItems.length) {
      setActiveLayerId(target.id);
      return;
    }
    const bad = selItems.filter((i) => (i.kind === 'bitmap') !== (target.mode === 'image'));
    if (bad.length)
      g.push(
        target.mode === 'image'
          ? `Lớp "${target.name}" là lớp khắc ảnh — bỏ qua ${bad.length} đối tượng vector`
          : `Lớp "${target.name}" không phải lớp khắc ảnh — bỏ qua ${bad.length} ảnh (đổi chế độ lớp thành "Khắc ảnh" nếu muốn)`,
      );
    setItems((a) => a.map((i) => (selSet.has(i.id) && (i.kind === 'bitmap') === (target.mode === 'image') ? { ...i, layerId: target.id } : i)));
    setActiveLayerId(target.id);
  }

  const propActions: PropertyActions = {
    moveTo: (dx, dy) => setItems((a) => moveItems(a, selSet, dx, dy)),
    resize: (sx, sy, fix) => setItems((a) => scaleItems(a, selSet, fix, sx, sy)),
    rotate: (deg) => applyTransform(deg),
    flip: (h, v) => applyTransform(0, h, v),
    align: (m, toBed) => setItems((a) => alignItems(a, selSet, m, toBed ? { minX: 0, minY: 0, maxX: machine.bedW, maxY: machine.bedH } : undefined)),
    distribute: (axis) => setItems((a) => distributeItems(a, selSet, axis)),
  };

  function deleteSelected() {
    if (!selItems.length) return;
    setItems((a) => a.filter((i) => !selSet.has(i.id)));
    setSelectedIds([]);
  }

  function copySelected() {
    clipboard.current = selItems;
  }

  function paste() {
    if (!clipboard.current.length) return;
    const c = cloneItems(clipboard.current, 5, -5);
    clipboard.current = c;
    setItems((a) => [...a, ...c]);
    setSelectedIds(c.map((i) => i.id));
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
    if (!selItems.length) return;
    const b = selBounds(selItems);
    const c = cloneItems(selItems, b.maxX - b.minX + 5, 0);
    setItems((a) => [...a, ...c]);
    setSelectedIds(c.map((i) => i.id));
  }

  async function addText(t: { text: string; font: string; size: number; align: TextAlign; layerId: string }, at?: Pt) {
    const r = await textToPaths(t.text, t.font, t.size, t.align);
    addItem({ name: `Chữ: ${t.text.split('\n')[0].slice(0, 20)}`, kind: 'vector', paths: r.paths, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: t.layerId }, at);
  }

  async function saveProject() {
    await window.laser.saveText('du-an.lzr', serializeProject(items, layers), 'project');
  }

  async function openProject() {
    const f = await window.laser.openProject();
    if (!f) return;
    try {
      const p = parseProject(f.text);
      hist.reset(p.items);
      setLayers(p.layers);
      setSelectedId(null);
      g.push(`Đã mở dự án ${f.name}`);
    } catch (e) {
      alert(`Không mở được dự án: ${(e as Error).message}`);
    }
  }

  // Phím tắt kiểu phần mềm thiết kế
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey) {
        const fn: Record<string, () => void> = {
          z: e.shiftKey ? hist.redo : hist.undo,
          y: hist.redo,
          c: copySelected,
          x: () => (copySelected(), deleteSelected()),
          v: paste,
          d: duplicateSelected,
          a: () => setSelectedIds(items.map((i) => i.id)),
        };
        if (fn[k]) {
          e.preventDefault();
          fn[k]();
        }
        return;
      }
      const tools: Record<string, Tool> = { v: 'select', l: 'line', r: 'rect', e: 'ellipse', p: 'polygon', t: 'text' };
      if (tools[k] && !e.altKey) return setTool(tools[k]);
      if (e.key === 'Escape') {
        setTool('select');
        setSelectedIds([]);
        return;
      }
      if (!selItems.length) return;
      const step = e.shiftKey ? 10 : 1;
      const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (e.key === 'Delete') deleteSelected();
      else if (mv[e.key]) {
        e.preventDefault();
        setItems((a) => moveItems(a, selSet, mv[e.key][0], mv[e.key][1]));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Móc kiểm thử dùng cho chế độ chụp màn hình tự động
  (window as any).__laserAction = async (name: string, ...args: any[]) => {
    if (name === 'select') setSelectedId(items[args[0]]?.id ?? null);
    if (name === 'preview') setShowPreview(!!args[0]);
    if (name === 'rotate') applyTransform(args[0], args[1], args[2]);
    if (name === 'trace') traceSelected({ threshold: 128, minArea: 0.5, smooth: 0.8 });
    if (name === 'text') await addText({ text: args[0], font: args[1], size: args[2], align: 'center', layerId: 'fill' });
    if (name === 'move') setItems((a) => a.map((i, k) => (k === args[0] ? { ...i, x: args[1], y: args[2] } : i)));
    if (name === 'tool') setTool(args[0]);
    if (name === 'mouse') {
      // args[0]: danh sách [loại, x_mm, y_mm, {shiftKey, detail...}]
      const cvEl = document.querySelector('.workspace canvas')!;
      for (const [type, x, y, opt] of args[0] as [string, number, number, any][]) {
        const [cx, cy] = (window as any).__wsClient(x, y);
        cvEl.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: cx, clientY: cy, button: 0, ...(opt ?? {}) }));
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    if (name === 'key') window.dispatchEvent(new KeyboardEvent('keydown', { key: args[0], ctrlKey: !!args[1], shiftKey: !!args[2] }));
    if (name === 'selectAll') setSelectedIds(items.map((i) => i.id));
    if (name === 'create') createDrawn(args[0]);
    if (name === 'color') pickColor(args[0]);
    if (name === 'align') propActions.align(args[0], !!args[1]);
    if (name === 'undo') hist.undo();
    if (name === 'redo') hist.redo();
    if (name === 'roundtrip') {
      const p = parseProject(serializeProject(items, layers));
      setItems(p.items);
      return p.items.length;
    }
    if (name === 'fonts') return (await window.laser.listFonts()).slice(0, 3);
    return items.map((i) => `${i.name} | ${i.kind} ${i.w.toFixed(1)}x${i.h.toFixed(1)} @${i.x.toFixed(1)},${i.y.toFixed(1)} paths=${i.paths?.length ?? 0} layer=${layers.find((l) => l.id === i.layerId)?.name}`).join('\n');
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
        <span className="sep" />
        <button onClick={hist.undo} disabled={!hist.canUndo} title="Hoàn tác (Ctrl+Z)">↶</button>
        <button onClick={hist.redo} disabled={!hist.canRedo} title="Làm lại (Ctrl+Y)">↷</button>
        <button onClick={duplicateSelected} disabled={!selItems.length} title="Nhân đôi (Ctrl+D)">⧉</button>
        <button onClick={deleteSelected} disabled={!selItems.length} title="Xóa (Delete)">🗑</button>
        <span className="sep" />
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
        <ToolBar tool={tool} setTool={setTool} sides={sides} setSides={setSides} />
        <div className="design">
          <PropertyBar sel={selItems} b={selItems.length ? selBounds(selItems) : null} act={propActions} />
          <Workspace
            bedW={machine.bedW}
            bedH={machine.bedH}
            items={items}
            layers={layers}
            selectedIds={selectedIds}
            tool={tool}
            polygonSides={sides}
            activeLayer={activeLayer}
            onSelect={setSelectedIds}
            onBeginEdit={hist.checkpoint}
            onLive={hist.set}
            onCommit={hist.commit}
            onCreate={createDrawn}
            onTextAt={(pt) => setTextAt(pt)}
            onToolDone={() => setTool('select')}
            laserPos={g.connected ? g.status.wpos : null}
            jobFrame={originMode === 'current' && items.length ? jobBounds(items, jobOpt) : null}
            preview={job?.preview ?? null}
          />
          <Palette layers={layers} activeId={activeLayerId} onPick={pickColor} />
        </div>
        <aside className="side">
          <ConnectionPanel g={g} machine={machine} setMachine={setMachine} />
          <JogPanel g={g} jog={jog} disabled={!g.connected || running} />
          <JobPanel originMode={originMode} setOriginMode={setOriginMode} anchor={anchor} setAnchor={setAnchor} machine={machine} setMachine={setMachine} />
          {selected && <ItemPanel item={selected} layers={layers} patch={(p) => patchItem(selected.id, p)} onTrace={traceSelected} />}
          <LayersPanel layers={layers} patch={patchLayer} reset={() => setLayers(DEFAULT_LAYERS)} />
        </aside>
      </main>

      {textAt && (
        <TextDialog
          layers={layers}
          defaultLayerId={activeLayer.mode !== 'image' ? activeLayer.id : undefined}
          onClose={() => setTextAt(null)}
          onOk={async (t) => {
            try {
              await addText(t, textAt);
              setTextAt(null);
              setTool('select');
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
  onTrace,
}: {
  item: Item;
  layers: Layer[];
  patch: (p: Partial<Item>) => void;
  onTrace: (o: TraceOptions) => void;
}) {
  const [th, setTh] = useState(128);
  const [smooth, setSmooth] = useState(0.8);
  /** Đổi thông số hình (bo góc, số cạnh) → vẽ lại đường theo kích thước hiện tại */
  const reshape = (spec: NonNullable<Item['shape']>) => {
    const paths = shapePaths(spec, item.w, item.h);
    if (paths) patch({ shape: spec, paths, srcW: item.w, srcH: item.h });
  };
  return (
    <section className="panel">
      <h3 title={item.name}>Đối tượng: {item.name}</h3>
      <div className="row">
        <label>Tên</label>
        <input value={item.name} onChange={(e) => patch({ name: e.target.value })} />
      </div>
      <div className="row">
        <label>Lớp</label>
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
        <button onClick={() => patch({ w: item.srcW, h: item.srcH })}>Về cỡ gốc</button>
      </div>
      {item.shape?.type === 'rect' && (
        <div className="row">
          <label>Bo góc (mm)</label>
          <NumField value={item.shape.radius ?? 0} min={0} step={0.5} onCommit={(v) => reshape({ type: 'rect', radius: v })} />
        </div>
      )}
      {item.shape?.type === 'polygon' && (
        <div className="row">
          <label>Số cạnh</label>
          <NumField value={item.shape.sides ?? 6} min={3} step={1} onCommit={(v) => reshape({ type: 'polygon', sides: Math.round(v) })} />
        </div>
      )}
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
