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
  openFiles: () => ipcRenderer.invoke('file:open'),
  saveText: (name: string, text: string, kind?: 'gcode' | 'project') => ipcRenderer.invoke('file:saveText', name, text, kind),
  openProject: () => ipcRenderer.invoke('file:openProject'),
  epsToPdf: (data: Uint8Array) => ipcRenderer.invoke('convert:eps', data),
  listFonts: () => ipcRenderer.invoke('font:list'),
  readFont: (file: string) => ipcRenderer.invoke('font:read', file),
  onLine: (cb: (l: string) => void) => on('grbl:line', cb),
  onProgress: (cb: (p: unknown) => void) => on('grbl:progress', cb),
  onClosed: (cb: () => void) => on('grbl:closed', cb),
};

contextBridge.exposeInMainWorld('laser', api);
export type LaserApi = typeof api;
