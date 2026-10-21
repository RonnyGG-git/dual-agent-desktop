import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppSnapshot, DadApi } from '../../shared/types';

// Superficie mínima y tipada: la interfaz nunca accede a Node ni a ipcRenderer directamente.
const api: DadApi = {
  getSnapshot: () => ipcRenderer.invoke('dad:getSnapshot'),
  submit: (instruction) => ipcRenderer.invoke('dad:submit', instruction),
  cancel: () => ipcRenderer.invoke('dad:cancel'),
  refreshEnvironment: () => ipcRenderer.invoke('dad:refreshEnvironment'),
  listHistory: () => ipcRenderer.invoke('dad:listHistory'),
  getTask: (id) => ipcRenderer.invoke('dad:getTask', id),
  updateSettings: (patch) => ipcRenderer.invoke('dad:updateSettings', patch),
  openPath: (target) => ipcRenderer.invoke('dad:openPath', target),
  onSnapshot: (cb) => {
    const listener = (_e: IpcRendererEvent, s: AppSnapshot) => cb(s);
    ipcRenderer.on('dad:snapshot', listener);
    return () => ipcRenderer.removeListener('dad:snapshot', listener);
  },
};

contextBridge.exposeInMainWorld('dad', api);
