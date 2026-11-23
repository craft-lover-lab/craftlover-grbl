import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GrblConnection } from './grbl';
import { epsToPdf, listFonts, readFont, type FontEntry } from './system';

let win: BrowserWindow | null = null;

// LASER_PROFILE=<folder>: run with a separate settings profile (clean first-run state for tests/screenshots)
if (process.env.LASER_PROFILE) app.setPath('userData', path.resolve(process.env.LASER_PROFILE));

const grbl = new GrblConnection({
  onLine: (line) => win?.webContents.send('grbl:line', line),
  onProgress: (p) => win?.webContents.send('grbl:progress', p),
  onClose: () => win?.webContents.send('grbl:closed'),
});

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
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
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

ipcMain.handle('serial:list', () => GrblConnection.list());
ipcMain.handle('serial:open', (_e, p: string, baud: number) => grbl.open(p, baud));
ipcMain.handle('serial:close', () => grbl.close());
ipcMain.handle('grbl:send', (_e, lines: string[]) => grbl.send(lines));
ipcMain.handle('grbl:realtime', (_e, b: number | string) => grbl.realtime(b));
ipcMain.handle('grbl:run', (_e, lines: string[]) => grbl.runJob(lines));
ipcMain.handle('grbl:pause', () => grbl.pause());
ipcMain.handle('grbl:resume', () => grbl.resume());
ipcMain.handle('grbl:abort', () => grbl.abort());

// Native dialog labels follow the language chosen in the UI
const DIALOG_TEXT = {
  en: { graphics: 'Graphics & vectors', all: 'All files', project: 'CraftLover GRBL project' },
  vi: { graphics: 'Hình & vector', all: 'Tất cả', project: 'Dự án CraftLover GRBL' },
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

ipcMain.handle('file:openProject', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: dt().project, extensions: ['lzr'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { name: path.basename(r.filePaths[0]), text: await readFile(r.filePaths[0], 'utf8') };
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
