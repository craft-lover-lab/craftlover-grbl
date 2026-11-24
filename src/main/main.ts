import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GrblConnection } from './grbl';
import { listPorts, openSerial } from './serialTransport';
import { epsToPdf, listFonts, readFont, type FontEntry } from './system';

let win: BrowserWindow | null = null;

// LASER_PROFILE=<folder>: run with a separate settings profile (clean first-run state for tests/screenshots)
if (process.env.LASER_PROFILE) app.setPath('userData', path.resolve(process.env.LASER_PROFILE));

const grbl = new GrblConnection(
  {
    onLine: (line) => win?.webContents.send('grbl:line', line),
    onProgress: (p) => win?.webContents.send('grbl:progress', p),
    onClose: () => win?.webContents.send('grbl:closed'),
    onFire: (on) => win?.webContents.send('grbl:fire', { on }),
  },
  { open: openSerial },
);

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'CraftLover GRBL',
    backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Snapshot mode: keep painting even when the window is covered
      backgroundThrottling: !process.env.LASER_SNAPSHOT,
    },
  });
  win.setMenuBarVisibility(false);
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  // LASER_CONFIRM=1 (snapshot tests only): answer every confirm() dialog with "yes"
  else win.loadFile(path.join(__dirname, '../renderer/index.html'), process.env.LASER_SNAPSHOT && process.env.LASER_CONFIRM ? { query: { autoconfirm: '1' } } : undefined);
  win.on('closed', () => (win = null));

  // Automated test: LASER_SNAPSHOT=path.png → capture a screenshot after loading, then quit
  const snap = process.env.LASER_SNAPSHOT;
  if (snap) {
    win.webContents.on('console-message', (e: any) => console.log('[renderer]', e.message ?? e));
    win.webContents.on('did-finish-load', () =>
      setTimeout(async () => {
        const demo = (process.env.LASER_DEMO ?? '').split(';').filter(Boolean);
        if (demo.length) {
          const files = await Promise.all(demo.map(async (p) => ({ name: path.basename(p), b64: (await readFile(p)).toString('base64') })));
          await win!.webContents.executeJavaScript(`window.__laserImport(${JSON.stringify(files)})`);
          if (process.env.LASER_COPIES) await win!.webContents.executeJavaScript(`window.__laserSetCopies(${process.env.LASER_COPIES})`);
          await new Promise((r) => setTimeout(r, 1500));
          // LASER_ACTIONS='[["select",0],["rotate",90]]' → run the scripted test actions in order
          for (const a of JSON.parse(process.env.LASER_ACTIONS ?? '[]') as unknown[][]) {
            const res = await win!.webContents.executeJavaScript(`window.__laserAction(...${JSON.stringify(a)})`);
            console.log('[action]', JSON.stringify(a), '→', typeof res === 'string' ? '\n' + res : JSON.stringify(res));
            await new Promise((r) => setTimeout(r, 400));
          }
          if (process.env.LASER_GCODE_OUT)
            await writeFile(process.env.LASER_GCODE_OUT, await win!.webContents.executeJavaScript('window.__laserGcode()'));
        }
        win!.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 300));
        const img = await win!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await writeFile(snap, img.toPNG());
        app.quit();
      }, 2500),
    );
  }
}

ipcMain.handle('serial:list', () => listPorts());
ipcMain.handle('serial:open', (_e, p: string, baud: number) => grbl.open(p, baud));
ipcMain.handle('serial:close', () => grbl.close());
ipcMain.handle('grbl:send', (_e, lines: string[]) => grbl.send(lines));
ipcMain.handle('grbl:realtime', (_e, b: number | string) => grbl.realtime(b));
ipcMain.handle('grbl:run', (_e, lines: string[]) => grbl.runJob(lines));
ipcMain.handle('grbl:pause', () => grbl.pause());
ipcMain.handle('grbl:resume', () => grbl.resume());
ipcMain.handle('grbl:abort', () => grbl.abort());
// Pre-start check: current machine state and fresh $-settings (refused while a job runs)
ipcMain.handle('grbl:check', async () => {
  // Ask for a fresh status report so the state is current
  grbl.realtime('?');
  const settings = await grbl.readSettings();
  await new Promise((r) => setTimeout(r, 300));
  return { state: grbl.machineState, settings, jobActive: grbl.jobActive, homed: grbl.homed };
});
// Positioning beam (Fire): stays on until switched off; turned off before jobs, on STOP and disconnect
ipcMain.handle('grbl:fire', (_e, on: boolean, s: number) => (on ? grbl.fire(s) : grbl.fireOff()));

// Native dialog labels follow the language chosen in the UI
const DIALOG_TEXT = {
  en: { graphics: 'Graphics & vectors', all: 'All files', project: 'CraftLover GRBL project', library: 'Material library' },
  vi: { graphics: 'Hình & vector', all: 'Tất cả', project: 'Dự án CraftLover GRBL', library: 'Thư viện vật liệu' },
} as const;
let uiLang: keyof typeof DIALOG_TEXT = 'en';
const dt = () => DIALOG_TEXT[uiLang];
ipcMain.handle('app:setLang', (_e, l: string) => {
  if (l in DIALOG_TEXT) uiLang = l as keyof typeof DIALOG_TEXT;
});

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: dt().graphics, extensions: ['svg', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'pdf', 'eps', 'ai'] },
      { name: dt().all, extensions: ['*'] },
    ],
  });
  if (r.canceled) return [];
  return Promise.all(
    r.filePaths.map(async (p) => ({ name: path.basename(p), data: new Uint8Array(await readFile(p)) })),
  );
});

ipcMain.handle('file:saveText', async (_e, defaultName: string, text: string, kind: 'gcode' | 'project' = 'gcode') => {
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: defaultName,
    filters: kind === 'project' ? [{ name: dt().project, extensions: ['lzr'] }] : [{ name: 'G-code', extensions: ['gcode', 'nc'] }],
  });
  if (r.canceled || !r.filePath) return false;
  await writeFile(r.filePath, text, 'utf8');
  return true;
});

// ---------- Projects: the main process remembers the current file, so "Save" (Ctrl+S)
// can only ever write to a file the user picked in a dialog ----------
let projectPath: string | null = null;
const atomicWrite = async (file: string, text: string) => {
  const tmp = file + '.tmp';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
};

ipcMain.handle('file:openProject', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: dt().project, extensions: ['lzr'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const text = await readFile(r.filePaths[0], 'utf8');
  projectPath = r.filePaths[0];
  return { name: path.basename(projectPath), text };
});

/** Save the project: to the current file, or via a dialog for "Save as" / a new project. */
ipcMain.handle('project:save', async (_e, text: string, saveAs: boolean, defaultName: string) => {
  let file = saveAs ? null : projectPath;
  if (!file) {
    const r = await dialog.showSaveDialog(win!, { defaultPath: projectPath ?? defaultName, filters: [{ name: dt().project, extensions: ['lzr'] }] });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  await atomicWrite(file, text);
  projectPath = file;
  return { name: path.basename(file) };
});

ipcMain.handle('project:forget', () => {
  projectPath = null;
});

// ---------- Autosave / crash recovery ----------
const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.lzr');
ipcMain.handle('autosave:write', (_e, text: string) => atomicWrite(autosaveFile(), text));
ipcMain.handle('autosave:read', async () => {
  try {
    const [text, st] = await Promise.all([readFile(autosaveFile(), 'utf8'), stat(autosaveFile())]);
    return { text, time: st.mtimeMs };
  } catch {
    return null;
  }
});
ipcMain.handle('autosave:clear', () => rm(autosaveFile(), { force: true }));

// ---------- Material library: stored as JSON in the app's user-data folder ----------
const libraryFile = () => path.join(app.getPath('userData'), 'materials.json');
ipcMain.handle('library:load', async () => {
  try {
    return JSON.parse(await readFile(libraryFile(), 'utf8'));
  } catch {
    return null; // first run: the renderer seeds the built-in presets
  }
});
ipcMain.handle('library:save', async (_e, presets: unknown) => {
  // Write to a temp file first so a crash never leaves a half-written library
  const tmp = libraryFile() + '.tmp';
  await writeFile(tmp, JSON.stringify(presets, null, 2), 'utf8');
  await rename(tmp, libraryFile());
});
ipcMain.handle('library:export', async (_e, text: string) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: 'materials.json', filters: [{ name: dt().library, extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return false;
  await writeFile(r.filePath, text, 'utf8');
  return true;
});
ipcMain.handle('library:import', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: dt().library, extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return readFile(r.filePaths[0], 'utf8');
});

ipcMain.handle('convert:eps', (_e, data: Uint8Array) => epsToPdf(data));

let fonts: FontEntry[] = [];
ipcMain.handle('font:list', async () => (fonts = await listFonts()));
ipcMain.handle('font:read', (_e, file: string) => readFont(file, fonts));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  grbl.close();
  app.quit();
});
