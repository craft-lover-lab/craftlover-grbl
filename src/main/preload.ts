import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

function on<T>(channel: string, cb: (v: T) => void) {
  const h = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api = {
  listPorts: () => ipcRenderer.invoke('serial:list'),
  open: (path: string, baud: number) => ipcRenderer.invoke('serial:open', path, baud),
  close: () => ipcRenderer.invoke('serial:close'),
  send: (lines: string[]) => ipcRenderer.invoke('grbl:send', lines),
  realtime: (b: number | string) => ipcRenderer.invoke('grbl:realtime', b),
  run: (lines: string[]) => ipcRenderer.invoke('grbl:run', lines),
  pause: () => ipcRenderer.invoke('grbl:pause'),
  resume: () => ipcRenderer.invoke('grbl:resume'),
  abort: () => ipcRenderer.invoke('grbl:abort'),
  checkMachine: () => ipcRenderer.invoke('grbl:check'),
  fire: (on: boolean, s = 0, seconds = 10) => ipcRenderer.invoke('grbl:fire', on, s, seconds),
  onFire: (cb: (v: { on: boolean; seconds: number }) => void) => on('grbl:fire', cb),
  openFiles: () => ipcRenderer.invoke('file:open'),
  saveText: (name: string, text: string, kind?: 'gcode' | 'project') => ipcRenderer.invoke('file:saveText', name, text, kind),
  openProject: () => ipcRenderer.invoke('file:openProject'),
  epsToPdf: (data: Uint8Array) => ipcRenderer.invoke('convert:eps', data),
  listFonts: () => ipcRenderer.invoke('font:list'),
  readFont: (file: string) => ipcRenderer.invoke('font:read', file),
  setLang: (lang: string) => ipcRenderer.invoke('app:setLang', lang),
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (presets: unknown) => ipcRenderer.invoke('library:save', presets),
  exportLibrary: (text: string) => ipcRenderer.invoke('library:export', text),
  importLibrary: () => ipcRenderer.invoke('library:import'),
  onLine: (cb: (l: string) => void) => on('grbl:line', cb),
  onProgress: (cb: (p: unknown) => void) => on('grbl:progress', cb),
  onClosed: (cb: () => void) => on('grbl:closed', cb),
};

contextBridge.exposeInMainWorld('laser', api);
export type LaserApi = typeof api;
