import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, Bounds, Item, JobOptions, Layer, MachineProfile, MaterialPreset, OriginMode, Pt } from '../core/types';
import { itemBounds, uid } from '../core/geometry';
import { activeItems, frameGcode, gcodeBounds, generateJob, insideBed, jobBounds } from '../core/gcode';
import { checkMachineTravel } from '../core/limits';
import { jobTiming, progressPlan } from '../core/gcodeTime';
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
import { MaterialLibrary } from './MaterialLibrary';
import { TestGridDialog } from './TestGridDialog';
import { migrateLegacyOrder } from '../core/layers';
import { booleanPaths, type BoolOp } from '../core/boolean';
import { itemWithPaths, worldPaths } from '../core/nodes';
import { builtinPresets, normalizePresets, presetFromLayer, presetToLayer } from '../core/materials';
import { buildTestGrid, type TestGridOptions } from '../core/testGrid';
import { PALETTE, Palette, PropertyBar, ToolBar, type PropertyActions } from './DesignBars';
import { AirBadge, ConnectionPanel, ItemPanel, JobPanel, JogPanel, LayersPanel } from './Panels';
import { alignItems, cloneItems, distributeItems, flipItems, moveItems, rotateItems, scaleItems, selBounds } from './designOps';

const DEFAULT_MACHINE: MachineProfile = {
  name: 'Sculpfun S30',
  laser: '10W diode',
  bedW: 410,
  bedH: 400,
  sMax: 1000,
  baud: 115200,
  frameSpeed: 3000,
  // Frame with a faint, visible beam (toggle next to the Frame button to frame with the laser off)
  framePower: 1,
  frameBeam: true,
  // Positioning beam ("Fire"): bright enough to see on a 10 W diode, far below marking power
  firePower: 3,
  // Air assist via M8/M9 (standard GRBL 1.1 accepts it even when no pump is wired)
  airAssist: true,
  // After STOP the machine stays where it is; a "Return to start" button is offered instead.
  // Moving on its own after an emergency-style stop would be unsafe (shifted part, fire, jam).
  returnAfterStop: false,
  // Fire switches itself off after 5 minutes
  fireMaxS: 300,
  travelSpeed: 6000,
};

/** Saved machine profile, upgraded to the current fields. */
function initialMachine(): MachineProfile {
  let m = load('machine', DEFAULT_MACHINE);
  // v0.1 framed with the laser off (0 %) and had no toggle: switch to the visible beam once
  if (m.frameBeam === undefined) m = { ...m, frameBeam: true, framePower: m.framePower > 0 ? m.framePower : 1 };
  // Air assist used to be an opt-in machine option; it is on by default now
  if (m.airAssist === undefined) m = { ...m, airAssist: true };
  // Automatic return after STOP used to be on by default: switch it off once (it stays available)
  if (localStorage.getItem('stopPolicy') !== '2') {
    m = { ...m, returnAfterStop: false };
    localStorage.setItem('stopPolicy', '2');
  }
  if (m.fireMaxS === undefined) m = { ...m, fireMaxS: 300 };
  return m;
}

/** "1:05" / "1:02:03" */
const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const baseLayer = { minPower: 0, passes: 1, lineInterval: 0.1, dither: 'floyd' as const, threshold: 128, overscan: 2.5, bidirectional: true, enabled: true };

/**
 * Default layers, named in the current language. Layers run top to bottom,
 * so engraving comes first and the outer cut last.
 */
const defaultLayers = (): Layer[] => [
  { ...baseLayer, id: 'image', name: t('layer.image'), color: '#333333', mode: 'image', speed: 3000, power: 50 },
  { ...baseLayer, id: 'fill', name: t('layer.fill'), color: '#18a058', mode: 'fill', speed: 6000, power: 40 },
  { ...baseLayer, id: 'score', name: t('layer.score'), color: '#2f7cf6', mode: 'line', speed: 3000, power: 30, air: true },
  { ...baseLayer, id: 'cut', name: t('layer.cut'), color: '#e5243b', mode: 'line', speed: 300, power: 100, air: true },
];

/** Saved layers; lists saved before layer ordering existed are migrated once. */
function initialLayers(): Layer[] {
  try {
    const v = localStorage.getItem('layers');
    if (!v) return defaultLayers();
    // Line (cut/score) layers saved before air assist existed get it switched on
    const ls: Layer[] = (JSON.parse(v) as Layer[]).map((l) => (l.air === undefined ? { ...l, air: l.mode === 'line' } : l));
    return localStorage.getItem('layerOrder') === '2' ? ls : migrateLegacyOrder(ls);
  } catch {
    return defaultLayers();
  }
}

type Doc = { items: Item[]; layers: Layer[] };
type Upd<T> = T | ((old: T) => T);
const apply = <T,>(u: Upd<T>, old: T): T => (typeof u === 'function' ? (u as (o: T) => T)(old) : u);

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
  const [machine, setMachine] = useState<MachineProfile>(initialMachine);
  // Objects and layers share one undo/redo history (Ctrl+Z / Ctrl+Y)
  const hist = useHistory<Doc>({ items: [], layers: initialLayers() });
  const { items, layers } = hist.state;
  const setItems = (u: Upd<Item[]>) => hist.commit((d) => ({ ...d, items: apply(u, d.items) }));
  const setLayers = (u: Upd<Layer[]>) => hist.commit((d) => ({ ...d, layers: apply(u, d.layers) }));
  const liveItems = (fn: (a: Item[]) => Item[]) => hist.set((d) => ({ ...d, items: fn(d.items) }));
  // Material library (persisted by the main process)
  const [presets, setPresetsState] = useState<MaterialPreset[]>([]);
  const [libDlg, setLibDlg] = useState<{ target?: Layer; draft?: MaterialPreset } | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const setSelectedId = (id: string | null) => setSelectedIds(id ? [id] : []);
  const [tool, setTool] = useState<Tool>('select');
  const [sides, setSides] = useState(6);
  const [activeLayerId, setActiveLayerId] = useState('cut');
  const [textAt, setTextAt] = useState<Pt | null>(null);
  /** Text object being edited in the text dialog */
  const [textEdit, setTextEdit] = useState<Item | null>(null);
  const clipboard = useRef<Item[]>([]);
  const [originMode, setOriginMode] = useState<OriginMode>('absolute');
  const [anchor, setAnchor] = useState<Anchor>('bl');
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => localStorage.setItem('machine', JSON.stringify(machine)), [machine]);
  useEffect(() => {
    localStorage.setItem('layers', JSON.stringify(layers));
    localStorage.setItem('layerOrder', '2');
  }, [layers]);

  // Load the material library; seed it with the built-in starting points on first run
  useEffect(() => {
    window.laser
      ?.loadLibrary?.()
      .then((data) => {
        let list: MaterialPreset[];
        try {
          list = data == null ? builtinPresets() : normalizePresets(data);
        } catch {
          list = builtinPresets();
        }
        setPresetsState(list);
        if (data == null) window.laser.saveLibrary(list);
      })
      .catch(() => setPresetsState(builtinPresets()));
  }, []);
  const setPresets = (p: MaterialPreset[]) => {
    setPresetsState(p);
    window.laser.saveLibrary(p);
  };
  // Tell the main process which language to use for native dialogs
  useEffect(() => {
    window.laser?.setLang?.(lang);
    // Default layers whose names were never edited follow the UI language
    // (not an undoable edit, so it bypasses the history)
    hist.set((d) => ({
      ...d,
      layers: d.layers.map((l) => {
        const key = `layer.${l.id}` as Key;
        return ['cut', 'score', 'fill', 'image'].includes(l.id) && allTranslations(key).includes(l.name) ? { ...l, name: t(key) } : l;
      }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const selSet = new Set(selectedIds);
  const selItems = items.filter((i) => selSet.has(i.id));
  const selected = selItems.length === 1 ? selItems[0] : null;
  const patchItem = (id: string, patch: Partial<Item>) => setItems((a) => a.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  // Typing into one layer field collapses into a single undo step
  const patchLayer = (id: string, patch: Partial<Layer>) =>
    hist.commitMerge(`layer:${id}:${Object.keys(patch).join(',')}`, (d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const layerCounts = items.reduce<Record<string, number>>((m, i) => ((m[i.layerId] = (m[i.layerId] ?? 0) + 1), m), {});

  /** First palette color not used by any layer. */
  const freeColor = (ls: Layer[] = layers) => PALETTE.find((c) => !ls.some((l) => l.color.toLowerCase() === c)) ?? PALETTE[ls.length % PALETTE.length];

  function addLayer() {
    const l: Layer = { ...baseLayer, id: uid(), name: t('layer.new', { n: layers.length + 1 }), color: freeColor(), mode: 'line', speed: 1000, power: 20, air: true };
    setLayers((a) => [...a, l]);
  }

  function removeLayer(id: string) {
    const l = layers.find((x) => x.id === id);
    if (!l) return;
    if (layers.length <= 1) return alert(t('layers.lastOne'));
    if (layerCounts[id]) return alert(t('layers.inUse', { name: l.name, n: layerCounts[id] }));
    setLayers((a) => a.filter((x) => x.id !== id));
    if (activeLayerId === id) setActiveLayerId(layers.find((x) => x.id !== id)!.id);
  }

  function moveLayer(from: number, to: number) {
    if (to < 0 || to >= layers.length || from === to) return;
    setLayers((a) => {
      const b = [...a];
      const [x] = b.splice(from, 1);
      b.splice(to, 0, x);
      return b;
    });
  }

  function applyPreset(layerId: string, pr: MaterialPreset) {
    setLayers((a) => a.map((l) => (l.id === layerId ? { ...l, ...presetToLayer(pr) } : l)));
  }

  /** "Save as material preset" from a test cell: the layer settings plus the cell's own speed/power. */
  function savePresetFromItem(it: Item) {
    const l = layers.find((x) => x.id === it.layerId);
    if (!l) return;
    const draft = presetFromLayer({ ...l, ...it.override }, { machine: machine.name, laser: machine.laser });
    // The test layer's name means nothing in the library; describe the operation by its mode instead
    draft.operation = t(`mode.${l.mode}` as Key).replace(/\s*\(.*\)$/, '');
    setLibDlg({ draft });
  }

  async function createTestGrid(o: TestGridOptions) {
    const fonts = await window.laser.listFonts().catch(() => []);
    const font = fonts.find((f) => /^arial$/i.test(f.name)) ?? fonts.find((f) => /arial|segoe ui|calibri/i.test(f.name)) ?? fonts[0];
    const used = [...layers];
    const cellsColor = freeColor(used);
    const labelsColor = freeColor([...used, { color: cellsColor } as Layer]);
    const r = await buildTestGrid(
      o,
      {
        cells: t('test.cellsLayer'),
        labels: t('test.labelsLayer'),
        cell: (sp, pw) => t('test.cellName', { speed: sp, power: pw }),
        speedAxis: t('test.speedAxis'),
        powerAxis: t('test.powerAxis'),
      },
      { cells: cellsColor, labels: labelsColor },
      async (s, size) => (font ? textToPaths(s, font.file, size, 'left').catch(() => null) : null),
    );
    // Test layers run before everything else that is already on the bed
    hist.commit((d) => ({ items: [...d.items, ...r.items], layers: [...r.layers, ...d.layers] }));
    setSelectedIds(r.items.map((i) => i.id));
    setTestOpen(false);
    g.push(t('test.created', { cols: r.speeds.length, rows: r.powers.length }));
  }
  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? layers[0];

  // Drop selection entries whose objects no longer exist (e.g. after undo)
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    if (selectedIds.some((id) => !ids.has(id))) setSelectedIds((s) => s.filter((id) => ids.has(id)));
  }, [items, selectedIds]);

  const jobOpt: JobOptions = { originMode, anchor, currentPos: g.status.wpos };
  // A job is running, paused or finishing: manual control and new jobs are locked
  const running = g.jobActive;

  // ---------- After STOP: go back to where the job started ----------
  const jobStart = useRef<Pt>({ x: 0, y: 0 });
  const pendingReturn = useRef<{ pos: Pt; until: number } | null>(null);
  /** After STOP: where the "Return to start" button would take the head */
  const [returnOffer, setReturnOffer] = useState<Pt | null>(null);
  useEffect(() => {
    const p = g.progress;
    if (p?.state === 'aborted' && p.reason === 'stopped') {
      const pos = jobStart.current;
      // Only when the user opted in; otherwise the machine stays put and a button is offered
      if (machine.returnAfterStop) setTimeout(() => (pendingReturn.current = { pos, until: Date.now() + 15000 }), 400);
      else setReturnOffer(pos);
    }
    if (p?.state === 'running') setReturnOffer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.progress?.state]);
  useEffect(() => {
    if (!g.connected) setReturnOffer(null);
  }, [g.connected]);
  /** Manual return after STOP: only when the controller has finished stopping and is Idle */
  function returnToStart() {
    const pos = returnOffer;
    if (!pos) return;
    const st = g.status.state.split(':')[0];
    if (g.stopping || st !== 'Idle') return alert(st === 'Alarm' ? t('stop.locked') : t('stop.notIdle', { state: g.status.state }));
    if (!confirm(t('stop.returnConfirm', { x: pos.x.toFixed(1), y: pos.y.toFixed(1) }))) return;
    setReturnOffer(null);
    g.push(t('stop.returning', { x: pos.x.toFixed(1), y: pos.y.toFixed(1) }));
    g.send(['M5 S0', `G90 G0 X${pos.x.toFixed(3)} Y${pos.y.toFixed(3)}`]);
  }
  useEffect(() => {
    const r = pendingReturn.current;
    if (!r) return;
    const st = g.status.state.split(':')[0];
    if (Date.now() > r.until) pendingReturn.current = null;
    else if (st === 'Alarm') {
      pendingReturn.current = null;
      g.push(`⚠ ${t('stop.locked')}`);
    } else if (st === 'Idle' && !g.jobActive && !g.stopping) {
      pendingReturn.current = null;
      g.push(t('stop.returning', { x: r.pos.x.toFixed(1), y: r.pos.y.toFixed(1) }));
      g.send(['M5 S0', `G90 G0 X${r.pos.x.toFixed(3)} Y${r.pos.y.toFixed(3)}`]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.status]);

  // ---------- Progress: time-weighted, with elapsed and remaining time ----------
  const [plan, setPlan] = useState<{ cum: number[]; total: number } | null>(null);
  const jobClock = useRef({ start: 0, pausedAt: 0, pausedTotal: 0, end: 0 });
  const [, setTick] = useState(0);
  useEffect(() => {
    const st = g.progress?.state;
    const c = jobClock.current;
    const now = Date.now();
    if (st === 'paused' && !c.pausedAt) c.pausedAt = now;
    if (st !== 'paused' && c.pausedAt) {
      c.pausedTotal += now - c.pausedAt;
      c.pausedAt = 0;
    }
    if ((st === 'done' || st === 'aborted' || st === 'failed') && c.start && !c.end) c.end = now;
  }, [g.progress?.state]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const c = jobClock.current;
  const elapsedS = c.start ? ((c.end || c.pausedAt || Date.now()) - c.start - c.pausedTotal) / 1000 : 0;
  const timing = plan && g.progress ? jobTiming(plan, g.progress.state === 'done' ? plan.cum.length - 1 : g.progress.acked, elapsedS) : null;

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
          addSvg(f.name, importSvg(new TextDecoder().decode(f.data)));
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

  /**
   * One object per SVG color, each on the layer with that color. Missing layers are created
   * with the original color (stroke → line mode, fill-only → fill mode), so a design that uses
   * red for cuts and black for engraving lands on two layers ready to set up. One undo step.
   */
  function addSvg(fileName: string, svg: ReturnType<typeof importSvg>) {
    const ids: string[] = [];
    hist.commit((d) => {
      const right = d.items.reduce((m, i) => Math.max(m, itemBounds(i).maxX), 0);
      const x0 = d.items.length && right + 5 + svg.w <= machine.bedW ? right + 5 : 10;
      const newLayers: Layer[] = [];
      const layerFor = (color: string, mode: 'line' | 'fill') => {
        const all = [...d.layers, ...newLayers];
        const hit = all.find((l) => l.color.toLowerCase() === color && l.mode !== 'image');
        if (hit) return hit.id;
        const l: Layer = {
          ...baseLayer,
          id: uid(),
          name: t('layer.svgColor', { color }),
          color,
          mode,
          // Low, safe defaults: the user sets real values (or loads a preset) before running
          speed: mode === 'fill' ? 6000 : 1000,
          power: 20,
          air: mode === 'line',
        };
        newLayers.push(l);
        return l.id;
      };
      const newItems: Item[] = svg.groups.map((gr) => {
        const id = uid();
        ids.push(id);
        return {
          id,
          name: svg.groups.length > 1 ? `${fileName} · ${gr.color}` : fileName,
          kind: 'vector' as const,
          paths: gr.paths,
          srcW: gr.w,
          srcH: gr.h,
          w: gr.w,
          h: gr.h,
          x: x0 + gr.x,
          y: 10 + gr.y,
          layerId: layerFor(gr.color, gr.mode),
          copies: COPIES_1,
        };
      });
      // Engraving runs before cutting (a part cut free may shift): new fill layers go in front of
      // the first cut/score layer, new cut/score layers at the end
      const fills = newLayers.filter((l) => l.mode === 'fill');
      const lines = newLayers.filter((l) => l.mode !== 'fill');
      const firstLine = d.layers.findIndex((l) => l.mode === 'line');
      const at = firstLine < 0 ? d.layers.length : firstLine;
      const layers = [...d.layers.slice(0, at), ...fills, ...d.layers.slice(at), ...lines];
      return { items: [...d.items, ...newItems], layers };
    });
    setSelectedIds(ids);
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
      layer = { ...baseLayer, id: uid(), name: t('layer.new', { n: layers.length + 1 }), color, mode: 'line', speed: 1000, power: 20, air: true };
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
    boolean: (op) => booleanSelected(op),
  };

  /**
   * Weld / subtract / intersect the selected vector objects into one new object on the
   * first object's layer. "First" is the first one clicked (or the oldest when box-selected);
   * subtract removes all the others from it.
   */
  function booleanSelected(op: BoolOp) {
    const vec = selectedIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i && i.kind === 'vector');
    if (vec.length < 2) return;
    const r = booleanPaths(op, vec.map(worldPaths));
    if (!r.paths.length) return alert(t('bool.empty'));
    // Open lines have no area and would be lost with the originals: ask first
    if (r.openIgnored && !confirm(t('bool.openConfirm', { n: r.openIgnored }))) return;
    const base = vec[0];
    const res = itemWithPaths({ ...base, id: uid(), name: t(`bool.name.${op}` as Key, { name: base.name }), override: undefined }, r.paths);
    const gone = new Set(vec.map((i) => i.id));
    setItems((a) => {
      // The result takes the place of the first object in the drawing order
      const at = a.findIndex((i) => i.id === base.id);
      const out = a.filter((i) => !gone.has(i.id));
      out.splice(Math.min(at, out.length), 0, res);
      return out;
    });
    setSelectedIds([res.id]);
  }

  /** Double-click / "Edit": text opens the text dialog, other vectors switch to node editing. */
  function editItem(it: Item) {
    if (it.text) setTextEdit(it);
    else if (it.kind === 'vector') {
      setSelectedIds([it.id]);
      setTool('node');
    }
  }

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
    const text = { text: spec.text, font: spec.font, size: spec.size, align: spec.align };
    addItem({ name, kind: 'vector', text, paths: r.paths, srcW: r.w, srcH: r.h, w: r.w, h: r.h, layerId: spec.layerId }, at);
  }

  /**
   * Regenerate a text object from new settings. Any stretching the user applied is kept
   * (same scale factors), and the object stays anchored by its alignment: left text keeps
   * its left edge, right text its right edge, centered text its center.
   */
  async function updateText(it: Item, spec: { text: string; font: string; size: number; align: TextAlign; layerId: string }) {
    const r = await textToPaths(spec.text, spec.font, spec.size, spec.align);
    const sx = it.srcW > 0 ? it.w / it.srcW : 1;
    const sy = it.srcH > 0 ? it.h / it.srcH : 1;
    const w = r.w * sx;
    const h = r.h * sy;
    const x = spec.align === 'left' ? it.x : spec.align === 'right' ? it.x + it.w - w : it.x + (it.w - w) / 2;
    const y = it.y + (it.h - h) / 2;
    const nameOf = (s: string) => t('text.itemName', { text: s.split('\n')[0].slice(0, 20) });
    // Names the user typed are kept; generated ones follow the new text
    const autoName = !it.text || it.name === nameOf(it.text.text);
    const text = { text: spec.text, font: spec.font, size: spec.size, align: spec.align };
    patchItem(it.id, { text, paths: r.paths, srcW: r.w, srcH: r.h, w, h, x, y, layerId: spec.layerId, ...(autoName ? { name: nameOf(spec.text) } : {}) });
  }

  // ---------- Project files ----------
  // ---------- Project file, unsaved changes, autosave ----------
  const [projectName, setProjectName] = useState<string | null>(null);
  /** The document as last saved / opened; anything else counts as unsaved changes */
  const [savedDoc, setSavedDoc] = useState<Doc | null>(null);
  const dirty = hist.state !== savedDoc && (items.length > 0 || (savedDoc?.items.length ?? 0) > 0);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${projectName ?? t('project.untitled')} — ${t('app.name')}`;
  }, [dirty, projectName, lang]);

  async function saveProject(saveAs = false) {
    try {
      const doc = hist.state;
      const r = await window.laser.saveProject(serializeProject(doc.items, doc.layers), saveAs, t('project.defaultName'));
      if (!r) return;
      setProjectName(r.name);
      setSavedDoc(doc);
      window.laser.autosaveClear();
      g.push(t('project.saved', { name: r.name }));
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function openProject() {
    if (dirty && !confirm(t('project.discard'))) return;
    const f = await window.laser.openProject();
    if (!f) return;
    try {
      const p = parseProject(f.text);
      const doc = { items: p.items, layers: p.layers };
      hist.reset(doc);
      setSavedDoc(doc);
      setProjectName(f.name);
      setSelectedId(null);
      window.laser.autosaveClear();
      g.push(t('project.opened', { name: f.name }));
    } catch (e) {
      alert(t('project.openFailed', { msg: errorText(e) }));
    }
  }

  // Autosave 3 s after the last change while there are unsaved changes. The file survives a
  // crash or an unexpected close and is offered back on the next start.
  useEffect(() => {
    if (!window.laser?.autosaveWrite) return;
    if (!dirty) return;
    const doc = hist.state;
    const id = setTimeout(() => {
      window.laser.autosaveWrite(JSON.stringify({ project: projectName, saved: Date.now(), data: serializeProject(doc.items, doc.layers) })).catch(() => {});
    }, 3000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist.state, dirty]);

  // On start: offer to restore work that was never saved
  useEffect(() => {
    window.laser
      ?.autosaveRead?.()
      .then((a) => {
        if (!a) return;
        let restored = false;
        try {
          const wrap = JSON.parse(a.text) as { project: string | null; data: string };
          const p = parseProject(wrap.data);
          const time = new Date(a.time).toLocaleString(lang);
          if (p.items.length && confirm(t('autosave.restore', { time }))) {
            hist.reset({ items: p.items, layers: p.layers });
            // Restored work is unsaved by definition; keep the file name for reference only
            setSavedDoc(null);
            window.laser.forgetProject();
            setProjectName(null);
            g.push(t('autosave.restored', { time }));
            restored = true;
          }
        } catch {
          /* unreadable autosave: drop it */
        }
        if (!restored) window.laser.autosaveClear();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Keyboard shortcuts (design-app style) ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+S / Ctrl+Shift+S work everywhere, even while typing in a field
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveProject(e.shiftKey);
        return;
      }
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
      const tools: Record<string, Tool> = { v: 'select', n: 'node', l: 'line', r: 'rect', e: 'ellipse', p: 'polygon', t: 'text' };
      if (tools[k] && !e.altKey) return setTool(tools[k]);
      if (e.key === 'Escape') {
        setTool('select');
        setSelectedIds([]);
        return;
      }
      if (!selItems.length) return;
      const step = e.shiftKey ? 10 : 1;
      const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      // In node editing, Delete removes the selected node (handled by the workspace)
      if (e.key === 'Delete' && tool !== 'node') deleteSelected();
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
    if (name === 'wait') await new Promise((r) => setTimeout(r, args[0]));
    if (name === 'machine') setMachine((m) => ({ ...m, ...args[0] }));
    if (name === 'scrollSide') document.querySelector('.side')?.scrollTo(0, 1e6);
    if (name === 'click') (document.querySelectorAll(args[0])[args[1] ?? 0] as HTMLElement | undefined)?.click();
    if (name === 'title') return document.title;
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
    if (name === 'test') await createTestGrid({ ...(await import('../core/testGrid')).DEFAULT_TEST, ...(args[0] ?? {}) });
    if (name === 'layers') return layers.map((l, i) => `${i + 1}. ${l.name} (${l.mode}) ${l.speed}/${l.power}%`).join('\n');
    if (name === 'moveLayer') moveLayer(args[0], args[1]);
    if (name === 'patchLayer') patchLayer(layers[args[0]].id, args[1]);
    if (name === 'presets') return presets.length;
    if (name === 'applyPreset') applyPreset(layers[args[0]].id, presets.find((x) => x.material === args[1] && x.operation === args[2])!);
    if (name === 'openLib') setLibDlg({ target: layers[args[0]] });
    if (name === 'openTest') setTestOpen(true);
    if (name === 'savePreset') savePresetFromItem(items[args[0]]);
    if (name === 'roundtrip') {
      const p = parseProject(serializeProject(items, layers));
      hist.reset({ items: p.items, layers: p.layers });
      return p.items.length;
    }
    if (name === 'boolean') booleanSelected(args[0]);
    if (name === 'selectIds') setSelectedIds(args[0].map((k: number) => items[k].id));
    if (name === 'editText') {
      const it = items[args[0]];
      await updateText(it, { ...it.text!, layerId: it.layerId, ...args[1] });
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
  const outOfBedText = (b: Bounds) =>
    t('job.outOfBed', { x0: b.minX.toFixed(1), y0: b.minY.toFixed(1), x1: b.maxX.toFixed(1), y1: b.maxY.toFixed(1), w: machine.bedW, h: machine.bedH });

  function buildJob() {
    if (activeItems(items, layers).length === 0) throw new Error(t('job.empty'));
    return generateJob(items, layers, machine, jobOpt);
  }

  /**
   * Make sure the controller is really ready before anything moves, and that the real
   * toolpath (overscan and travel included) stays within reach. Problems block the run —
   * there is no "continue anyway".
   *
   * - Homed in this session (and homing enabled): check MACHINE coordinates against $130/$131.
   * - Not homed: machine zero is arbitrary, so only the work-coordinate bed check is possible;
   *   it is enforced, but the user is told that physical limits are not verified.
   */
  async function machineReady(kind: 'job' | 'frame', motion: Bounds): Promise<{ ok: boolean; unverified: boolean }> {
    let r: Awaited<ReturnType<typeof window.laser.checkMachine>>;
    try {
      r = await window.laser.checkMachine();
    } catch (e) {
      alert(t('check.failed', { msg: errorText(e) }));
      return { ok: false, unverified: true };
    }
    const problems: string[] = [];
    const state = r.state.split(':')[0];
    if (r.jobActive) problems.push(t('job.busy'));
    if (state !== 'Idle') problems.push(state === 'Alarm' ? t('check.alarm') : t('check.notIdle', { state: r.state || '?' }));
    if (kind === 'job') {
      if (r.settings['$32'] !== '1') problems.push(t('check.laserMode', { value: r.settings['$32'] ?? '?' }));
      const smax = Number(r.settings['$30']);
      if (!Number.isFinite(smax) || smax !== machine.sMax) problems.push(t('check.sMax', { grbl: r.settings['$30'] ?? '?', app: machine.sMax }));
    }
    const tx = Number(r.settings['$130']);
    const ty = Number(r.settings['$131']);
    const verified = r.homed && r.settings['$22'] === '1' && tx > 0 && ty > 0;
    if (verified) {
      const p = checkMachineTravel(motion, g.wco.current, g.status.mpos, { x: tx, y: ty });
      if (p) problems.push(t('check.travel', { axis: p.axis, lo: p.lo.toFixed(1), hi: p.hi.toFixed(1), min: p.min.toFixed(1), max: p.max.toFixed(1) }));
    } else if (!insideBed(motion, machine)) problems.push(outOfBedText(motion));
    if (problems.length) {
      alert(`${t('check.title')}\n\n• ${problems.join('\n• ')}`);
      return { ok: false, unverified: !verified };
    }
    return { ok: true, unverified: !verified };
  }

  async function exportGcode() {
    try {
      const j = buildJob();
      // A file can be run elsewhere, so this stays a warning rather than a block
      if (!insideBed(j.motion, machine) && !confirm(`${outOfBedText(j.motion)} ${t('job.saveAnyway')}`)) return;
      await window.laser.saveText('job.gcode', j.lines.join('\n') + '\n');
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function startJob() {
    try {
      const j = buildJob();
      const ready = await machineReady('job', j.motion);
      if (!ready.ok) return;
      let note = ready.unverified ? `\n\n${t('job.unverifiedTravel')}` : '';
      // Layers that want air assist while the machine option is off: the pump will not be switched
      if (!machine.airAssist) {
        const used = new Set(activeItems(items, layers).map((i) => i.layerId));
        const airLayers = layers.filter((l) => l.enabled && l.air && used.has(l.id)).map((l) => l.name);
        if (airLayers.length) note += `\n\n⚠ ${t('job.airNotEnabled', { layers: airLayers.join(', ') })}`;
      }
      if (!confirm(t('job.confirmStart', { n: j.lines.length, time: fmtTime(j.seconds) }) + note)) return;
      setPlan(progressPlan(j.lines, machine.travelSpeed));
      jobStart.current = originMode === 'current' ? { ...g.status.wpos } : { x: 0, y: 0 };
      jobClock.current = { start: Date.now(), pausedAt: 0, pausedTotal: 0, end: 0 };
      await window.laser.run(j.lines);
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function runFrame() {
    const lines = frameGcode(activeItems(items, layers), { ...machine, framePower: machine.frameBeam ? machine.framePower : 0 }, jobOpt);
    if (!lines.length) return alert(t('frame.empty'));
    if (!(await machineReady('frame', gcodeBounds(lines))).ok) return;
    await g.send(lines);
  }

  const jog = (dx: number, dy: number, step: number, feed: number) => g.send(`$J=G91 G21 X${(dx * step).toFixed(3)} Y${(dy * step).toFixed(3)} F${feed}`);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">⚡ {t('app.name')}</strong>
        <button onClick={openProject} title={t('tb.openTip')}>
          📁 <span className="lbl">{t('tb.open')}</span>
        </button>
        <button onClick={() => saveProject(false)} disabled={!items.length} title={t('tb.saveTip')}>
          💾 <span className="lbl">{t('tb.save')}</span>
        </button>
        <button onClick={() => importFiles()} title={t('tb.importTip')}>
          📥 {t('tb.import')}
        </button>
        <button onClick={() => setLibDlg({})} title={t('tb.libraryTip')}>
          📚 {t('tb.library')}
        </button>
        <button onClick={() => setTestOpen(true)} title={t('tb.testTip')}>
          🧪 {t('tb.test')}
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
        <button onClick={exportGcode} disabled={!items.length} title={t('tb.export')}>
          ⤓ <span className="lbl">{t('tb.export')}</span>
        </button>
        <button className="warn" onClick={runFrame} disabled={!g.connected || running || !items.length} title={t('tb.frameTip')}>
          ⬚ {t('tb.frame')}
        </button>
        <button
          className={`beam-toggle ${machine.frameBeam ? 'on' : ''}`}
          onClick={() => setMachine({ ...machine, frameBeam: !machine.frameBeam, framePower: machine.framePower > 0 ? machine.framePower : 1 })}
          title={machine.frameBeam ? t('tb.frameBeamOn', { power: machine.framePower }) : t('tb.frameBeamOff')}
        >
          {machine.frameBeam ? '🔆' : '🌑'}
        </button>
        <button className="go" onClick={startJob} disabled={!g.connected || running || !items.length}>
          ▶ {t('tb.start')}
        </button>
        {running && g.progress?.state !== 'paused' && <button onClick={() => window.laser.pause()}>⏸ {t('tb.pause')}</button>}
        {g.progress?.state === 'paused' && <button onClick={() => window.laser.resume()}>⏵ {t('tb.resume')}</button>}
        <button className="stop" onClick={() => window.laser.abort()} disabled={!g.connected}>
          ■ {g.stopping ? t('tb.stopping') : t('tb.stop')}
        </button>
        {returnOffer && !running && g.connected && (
          <span className="return-offer">
            <button onClick={returnToStart} disabled={g.stopping} title={t('stop.returnTip')}>
              ⌂ {t('stop.returnBtn')}
            </button>
            <button className="tiny" onClick={() => setReturnOffer(null)} title={t('stop.dismiss')}>
              ✕
            </button>
          </span>
        )}
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
            onLive={liveItems}
            onCommit={setItems}
            onCreate={createDrawn}
            onTextAt={(pt) => setTextAt(pt)}
            onToolDone={() => setTool('select')}
            onEditItem={editItem}
            laserPos={g.connected ? g.status.wpos : null}
            jobFrame={originMode === 'current' && activeItems(items, layers).length ? jobBounds(activeItems(items, layers), jobOpt) : null}
            preview={job?.preview ?? null}
          />
          <Palette layers={layers} activeId={activeLayerId} onPick={pickColor} />
        </div>
        <aside className="side">
          <ConnectionPanel g={g} machine={machine} setMachine={setMachine} locked={running} />
          <JogPanel g={g} jog={jog} disabled={!g.connected || running || g.stopping} sMax={machine.sMax} firePower={machine.firePower ?? 3} fireMaxS={machine.fireMaxS ?? 300} />
          <JobPanel originMode={originMode} setOriginMode={setOriginMode} anchor={anchor} setAnchor={setAnchor} machine={machine} setMachine={setMachine} />
          {selected && <ItemPanel item={selected} layers={layers} patch={(p) => patchItem(selected.id, p)} onTrace={traceSelected} onSavePreset={savePresetFromItem} onEditText={editItem} onEditNodes={(it) => (setSelectedIds([it.id]), setTool('node'))} />}
          <LayersPanel
            layers={layers}
            counts={layerCounts}
            patch={patchLayer}
            reset={() => setLayers((cur) => [...defaultLayers(), ...cur.filter((l) => !['cut', 'score', 'fill', 'image'].includes(l.id))])}
            add={addLayer}
            remove={removeLayer}
            move={moveLayer}
            fromLib={(l) => setLibDlg({ target: l })}
            toLib={(l) => setLibDlg({ draft: presetFromLayer(l, { machine: machine.name, laser: machine.laser }) })}
            airAssist={!!machine.airAssist}
          />
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

      {textEdit?.text && (
        <TextDialog
          layers={layers}
          initial={{ ...textEdit.text, layerId: textEdit.layerId }}
          onClose={() => setTextEdit(null)}
          onOk={async (spec) => {
            try {
              await updateText(textEdit, spec);
              setTextEdit(null);
            } catch (e) {
              alert(errorText(e));
            }
          }}
        />
      )}

      {libDlg && (
        <MaterialLibrary
          presets={presets}
          setPresets={setPresets}
          machine={{ name: machine.name, laser: machine.laser }}
          target={libDlg.target}
          onApply={libDlg.target ? (pr) => applyPreset(libDlg.target!.id, pr) : undefined}
          draft={libDlg.draft}
          onClose={() => setLibDlg(null)}
          log={g.push}
        />
      )}

      {testOpen && <TestGridDialog onClose={() => setTestOpen(false)} onCreate={createTestGrid} />}

      <footer className="status">
        <span className={`dot ${g.connected ? 'on' : ''}`} /> {g.connected ? g.status.state : t('status.disconnected')}
        <span>X {g.status.wpos.x.toFixed(2)}</span>
        <span>Y {g.status.wpos.y.toFixed(2)}</span>
        {g.connected && <AirBadge air={g.status.air} />}
        {g.progress && g.progress.total > 0 && (
          <span className={`job-progress job-${g.progress.state}`} title={t('prog.tip', { done: g.progress.acked, total: g.progress.total })}>
            <b>{t(`job.state.${g.progress.state}` as Key)}</b>
            <span className="bar">
              <span style={{ width: `${Math.round((timing?.frac ?? g.progress.acked / g.progress.total) * 100)}%` }} />
            </span>
            <b>{Math.round((timing?.frac ?? g.progress.acked / g.progress.total) * 100)}%</b>
            {c.start > 0 && <span>{t('prog.elapsed', { t: clock(elapsedS) })}</span>}
            {running && timing && <span>{t('prog.remaining', { t: clock(timing.remainingS) })}</span>}
            {g.progress.errors > 0 && <span>{t('status.errors', { n: g.progress.errors })}</span>}
          </span>
        )}
        {busy && <span>{busy}</span>}
        <span className="spacer" />
        <span className="muted">{g.version}</span>
      </footer>
    </div>
  );
}
