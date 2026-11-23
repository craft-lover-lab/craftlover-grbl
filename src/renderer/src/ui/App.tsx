import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, Item, JobOptions, Layer, MachineProfile, OriginMode, Pt } from '../core/types';
import { itemBounds, uid } from '../core/geometry';
import { frameGcode, generateJob, jobBounds } from '../core/gcode';
import { importSvg } from '../io/svg';
import { importPdf, importRaster } from '../io/image';
import { textToPaths, type TextAlign } from '../io/text';
import { parseProject, serializeProject } from '../io/project';
import { traceBitmap, type TraceOptions } from '../core/trace';
import { useGrbl } from '../machine/useGrbl';
import { allTranslations, errorText, LANGS, setLang, t, useLang, type Key, type Lang } from '../i18n';
import { Workspace, type NewItem, type Tool } from './Workspace';
import { TextDialog } from './TextDialog';
import { useHistory } from './useHistory';
import { Palette, PropertyBar, ToolBar, type PropertyActions } from './DesignBars';
import { ConnectionPanel, ItemPanel, JobPanel, JogPanel, LayersPanel } from './Panels';
import { alignItems, cloneItems, distributeItems, flipItems, moveItems, rotateItems, scaleItems, selBounds } from './designOps';

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

/** Default layers, named in the current language. */
const defaultLayers = (): Layer[] => [
  { ...baseLayer, id: 'cut', name: t('layer.cut'), color: '#e5243b', mode: 'line', speed: 300, power: 100 },
  { ...baseLayer, id: 'score', name: t('layer.score'), color: '#2f7cf6', mode: 'line', speed: 3000, power: 30 },
  { ...baseLayer, id: 'fill', name: t('layer.fill'), color: '#18a058', mode: 'fill', speed: 6000, power: 40 },
  { ...baseLayer, id: 'image', name: t('layer.image'), color: '#333333', mode: 'image', speed: 3000, power: 50 },
];

const COPIES_1 = { cols: 1, rows: 1, gapX: 5, gapY: 5 };

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
  return m >= 60 ? t('time.hm', { h: Math.floor(m / 60), m: m % 60 }) : t('time.ms', { m, s: Math.round(s % 60) });
};

export function App() {
  const lang = useLang();
  const g = useGrbl();
  const [machine, setMachine] = useState<MachineProfile>(() => load('machine', DEFAULT_MACHINE));
  const [layers, setLayers] = useState<Layer[]>(() => {
    try {
      const v = localStorage.getItem('layers');
      return v ? JSON.parse(v) : defaultLayers();
    } catch {
      return defaultLayers();
    }
  });
  // Object list with undo/redo (Ctrl+Z / Ctrl+Y)
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
  // Tell the main process which language to use for native dialogs
  useEffect(() => {
    window.laser?.setLang?.(lang);
    // Default layers whose names were never edited follow the UI language
    setLayers((ls) =>
      ls.map((l) => {
        const key = `layer.${l.id}` as Key;
        return ['cut', 'score', 'fill', 'image'].includes(l.id) && allTranslations(key).includes(l.name) ? { ...l, name: t(key) } : l;
      }),
    );
  }, [lang]);

  const selSet = new Set(selectedIds);
  const selItems = items.filter((i) => selSet.has(i.id));
  const selected = selItems.length === 1 ? selItems[0] : null;
  const patchItem = (id: string, patch: Partial<Item>) => setItems((a) => a.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const patchLayer = (id: string, patch: Partial<Layer>) => setLayers((a) => a.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? layers[0];

  // Drop selection entries whose objects no longer exist (e.g. after undo)
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    if (selectedIds.some((id) => !ids.has(id))) setSelectedIds((s) => s.filter((id) => ids.has(id)));
  }, [items, selectedIds]);

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

  // ---------- Import ----------
  async function importFiles(given?: { name: string; data: Uint8Array }[]) {
    const files = given ?? (await window.laser.openFiles());
    for (const f of files) {
      const ext = f.name.split('.').pop()!.toLowerCase();
      setBusy(t('import.busy', { name: f.name }));
      try {
        const add = (it: Omit<Item, 'id' | 'x' | 'y' | 'copies'>) => {
          const id = uid();
          setItems((a) => {
            // Place new objects to the right of existing ones while they still fit on the bed
            const right = a.reduce((m, i) => Math.max(m, itemBounds(i).maxX), 0);
            const x = a.length && right + 5 + it.w <= machine.bedW ? right + 5 : 10;
            return [...a, { ...it, id, x, y: 10, copies: COPIES_1 }];
          });
          setSelectedId(id);
        };
        if (ext === 'svg') {
          const r = importSvg(new TextDecoder().decode(f.data));
          add({ name: f.name, kind: 'vector', paths: r.paths, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: 'cut' });
        } else if (ext === 'pdf' || ext === 'ai' || ext === 'eps') {
          // EPS is converted to PDF by Ghostscript (vectors preserved), then read like a PDF
          const pdf = ext === 'eps' ? await window.laser.epsToPdf(f.data) : f.data;
          const pages = await importPdf(pdf);
          pages.forEach((pg, i) => {
            const base = pages.length > 1 ? t('import.page', { name: f.name, n: i + 1 }) : f.name;
            const v = pg.vector;
            if (v.paths.length) add({ name: base, kind: 'vector', paths: v.paths, srcW: v.w, srcH: v.h, w: v.w, h: v.h, layerId: 'cut' });
            if (pg.raster) {
              const r = pg.raster;
              add({ name: t('import.imageCopy', { name: base }), kind: 'bitmap', bitmap: r.bitmap, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: 'image' });
              if (v.paths.length) g.push(t('import.pdfTextNote', { name: base }));
            }
          });
        } else {
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          const r = await importRaster(f.data, mime);
          add({ name: f.name, kind: 'bitmap', bitmap: r.bitmap, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: 'image' });
        }
        g.push(t('import.done', { name: f.name }));
      } catch (e) {
        g.push(t('import.errorLog', { name: f.name, msg: errorText(e) }));
        if (!given) alert(t('import.errorAlert', { name: f.name, msg: errorText(e) }));
      }
    }
    setBusy('');
  }

  // ---------- Editing ----------
  function addItem(it: Omit<Item, 'id' | 'x' | 'y' | 'copies'>, at?: { x: number; y: number }) {
    const id = uid();
    setItems((a) => [...a, { ...it, id, x: at?.x ?? 10, y: at?.y ?? 10, copies: COPIES_1 }]);
    setSelectedId(id);
    return id;
  }

  function createDrawn(it: NewItem) {
    const id = uid();
    setItems((a) => [...a, { ...it, id, copies: COPIES_1 }]);
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

  /** Palette click: move the selection to that color's layer (creating the layer if needed). */
  function pickColor(color: string) {
    let layer = layers.find((l) => l.color.toLowerCase() === color);
    if (!layer) {
      layer = { ...baseLayer, id: uid(), name: t('layer.new', { n: layers.length + 1 }), color, mode: 'line', speed: 1000, power: 20 };
      const nl = layer;
      setLayers((a) => [...a, nl]);
    }
    const target = layer;
    if (!selItems.length) {
      setActiveLayerId(target.id);
      return;
    }
    const bad = selItems.filter((i) => (i.kind === 'bitmap') !== (target.mode === 'image'));
    if (bad.length) g.push(t(target.mode === 'image' ? 'palette.skipVector' : 'palette.skipImage', { name: target.name, n: bad.length }));
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

  function duplicateSelected() {
    if (!selItems.length) return;
    const b = selBounds(selItems);
    const c = cloneItems(selItems, b.maxX - b.minX + 5, 0);
    setItems((a) => [...a, ...c]);
    setSelectedIds(c.map((i) => i.id));
  }

  function traceSelected(opt: TraceOptions) {
    if (!selected?.bitmap) return;
    const paths = traceBitmap(selected.bitmap, selected.w, selected.h, opt);
    if (!paths.length) return alert(t('trace.none'));
    addItem(
      { name: t('trace.name', { name: selected.name }), kind: 'vector', paths, srcW: selected.w, srcH: selected.h, w: selected.w, h: selected.h, layerId: 'cut' },
      selected,
    );
    g.push(t('trace.done', { n: paths.length, name: selected.name }));
  }

  async function addText(spec: { text: string; font: string; size: number; align: TextAlign; layerId: string }, at?: Pt) {
    const r = await textToPaths(spec.text, spec.font, spec.size, spec.align);
    const name = t('text.itemName', { text: spec.text.split('\n')[0].slice(0, 20) });
    addItem({ name, kind: 'vector', paths: r.paths, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: spec.layerId }, at);
  }

  // ---------- Project files ----------
  async function saveProject() {
    await window.laser.saveText(t('project.defaultName'), serializeProject(items, layers), 'project');
  }

  async function openProject() {
    const f = await window.laser.openProject();
    if (!f) return;
    try {
      const p = parseProject(f.text);
      hist.reset(p.items);
      setLayers(p.layers);
      setSelectedId(null);
      g.push(t('project.opened', { name: f.name }));
    } catch (e) {
      alert(t('project.openFailed', { msg: errorText(e) }));
    }
  }

  // ---------- Keyboard shortcuts (design-app style) ----------
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

  // ---------- Test hooks used by the automated snapshot mode (LASER_ACTIONS) ----------
  (window as any).__laserAction = async (name: string, ...args: any[]) => {
    if (name === 'lang') setLang(args[0]);
    if (name === 'select') setSelectedId(items[args[0]]?.id ?? null);
    if (name === 'preview') setShowPreview(!!args[0]);
    if (name === 'rotate') applyTransform(args[0], args[1], args[2]);
    if (name === 'trace') traceSelected({ threshold: 128, minArea: 0.5, smooth: 0.8 });
    if (name === 'text') await addText({ text: args[0], font: args[1], size: args[2], align: 'center', layerId: 'fill' });
    if (name === 'move') setItems((a) => a.map((i, k) => (k === args[0] ? { ...i, x: args[1], y: args[2] } : i)));
    if (name === 'tool') setTool(args[0]);
    if (name === 'mouse') {
      // args[0]: list of [eventType, x_mm, y_mm, {shiftKey, detail, ...}]
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
    return items
      .map((i) => `${i.name} | ${i.kind} ${i.w.toFixed(1)}x${i.h.toFixed(1)} @${i.x.toFixed(1)},${i.y.toFixed(1)} paths=${i.paths?.length ?? 0} layer=${layers.find((l) => l.id === i.layerId)?.name}`)
      .join('\n');
  };
  (window as any).__laserImport = (files: { name: string; b64: string }[], preview = true) => {
    setShowPreview(preview);
    return importFiles(files.map((f) => ({ name: f.name, data: Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) })));
  };
  (window as any).__laserGcode = () => generateJob(items, layers, machine, jobOpt).lines.join('\n');
  (window as any).__laserSetCopies = (cols: number, rows: number) => setItems((a) => a.map((i, k) => (k === 0 ? { ...i, copies: { ...i.copies, cols, rows } } : i)));

  // ---------- Running jobs ----------
  function buildJob() {
    if (items.length === 0) throw new Error(t('job.empty'));
    const b = jobBounds(items, jobOpt);
    if (b.minX < -0.01 || b.minY < -0.01 || b.maxX > machine.bedW + 0.01 || b.maxY > machine.bedH + 0.01) {
      const msg = t('job.outOfBed', { x0: b.minX.toFixed(1), y0: b.minY.toFixed(1), x1: b.maxX.toFixed(1), y1: b.maxY.toFixed(1), w: machine.bedW, h: machine.bedH });
      if (!confirm(msg)) return null;
    }
    return generateJob(items, layers, machine, jobOpt);
  }

  async function exportGcode() {
    try {
      const j = buildJob();
      if (j) await window.laser.saveText('job.gcode', j.lines.join('\n') + '\n');
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function startJob() {
    try {
      const j = buildJob();
      if (!j) return;
      if (!confirm(t('job.confirmStart', { n: j.lines.length, time: fmtTime(j.seconds) }))) return;
      await window.laser.run(j.lines);
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function runFrame() {
    const lines = frameGcode(items, machine, jobOpt);
    if (!lines.length) return alert(t('frame.empty'));
    await g.send(lines);
  }

  const jog = (dx: number, dy: number, step: number, feed: number) => g.send(`$J=G91 G21 X${(dx * step).toFixed(3)} Y${(dy * step).toFixed(3)} F${feed}`);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">⚡ {t('app.name')}</strong>
        <button onClick={openProject} title={t('tb.openTip')}>📁 {t('tb.open')}</button>
        <button onClick={saveProject} disabled={!items.length} title={t('tb.saveTip')}>
          💾 {t('tb.save')}
        </button>
        <button onClick={() => importFiles()} title={t('tb.importTip')}>
          📥 {t('tb.import')}
        </button>
        <span className="sep" />
        <button onClick={hist.undo} disabled={!hist.canUndo} title={t('tb.undo')}>↶</button>
        <button onClick={hist.redo} disabled={!hist.canRedo} title={t('tb.redo')}>↷</button>
        <button onClick={duplicateSelected} disabled={!selItems.length} title={t('tb.duplicate')}>⧉</button>
        <button onClick={deleteSelected} disabled={!selItems.length} title={t('tb.delete')}>🗑</button>
        <span className="sep" />
        <label className="chk">
          <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} /> {t('tb.preview')}
        </label>
        {job && <span className="muted">{t('tb.estimate', { time: fmtTime(job.seconds), n: job.lines.length })}</span>}
        <span className="spacer" />
        <button onClick={exportGcode} disabled={!items.length}>⤓ {t('tb.export')}</button>
        <button className="warn" onClick={runFrame} disabled={!g.connected || running || !items.length} title={t('tb.frameTip')}>
          ⬚ {t('tb.frame')}
        </button>
        <button className="go" onClick={startJob} disabled={!g.connected || running || !items.length}>
          ▶ {t('tb.start')}
        </button>
        {running && !g.progress?.paused && <button onClick={() => window.laser.pause()}>⏸ {t('tb.pause')}</button>}
        {running && g.progress?.paused && <button onClick={() => window.laser.resume()}>⏵ {t('tb.resume')}</button>}
        <button className="stop" onClick={() => window.laser.abort()} disabled={!g.connected}>
          ■ {t('tb.stop')}
        </button>
        <select className="lang" value={lang} title={t('lang.label')} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              🌐 {l.name}
            </option>
          ))}
        </select>
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
          <LayersPanel layers={layers} patch={patchLayer} reset={() => setLayers(defaultLayers())} />
        </aside>
      </main>

      {textAt && (
        <TextDialog
          layers={layers}
          defaultLayerId={activeLayer.mode !== 'image' ? activeLayer.id : undefined}
          onClose={() => setTextAt(null)}
          onOk={async (spec) => {
            try {
              await addText(spec, textAt);
              setTextAt(null);
              setTool('select');
            } catch (e) {
              alert(errorText(e));
            }
          }}
        />
      )}

      <footer className="status">
        <span className={`dot ${g.connected ? 'on' : ''}`} /> {g.connected ? g.status.state : t('status.disconnected')}
        <span>X {g.status.wpos.x.toFixed(2)}</span>
        <span>Y {g.status.wpos.y.toFixed(2)}</span>
        {g.progress && g.progress.total > 0 && (
          <span>
            {t('status.progress', { pct: Math.round((100 * g.progress.acked) / g.progress.total), done: g.progress.acked, total: g.progress.total })}
            {g.progress.errors > 0 && t('status.errors', { n: g.progress.errors })}
          </span>
        )}
        {busy && <span>{busy}</span>}
        <span className="spacer" />
        <span className="muted">{g.version}</span>
      </footer>
    </div>
  );
}
