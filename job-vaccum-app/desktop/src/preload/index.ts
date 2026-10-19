import { contextBridge, ipcRenderer } from "electron";
import type { ConnectionState, JobVaccumApi } from "../shared/api";

// Sandboxed preload only requires Electron; do not import runtime local modules.
const api: JobVaccumApi = {
  getConnection: () => ipcRenderer.invoke("app:connection"),
  onConnectionChange(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: ConnectionState) => listener(state);
    ipcRenderer.on("app:connection-changed", receive);
    return () => ipcRenderer.removeListener("app:connection-changed", receive);
  },
  getStatus: () => ipcRenderer.invoke("app:status"),
  ping: (message) => ipcRenderer.invoke("app:ping", message),
  getDiagnostics: () => ipcRenderer.invoke("app:diagnostics"),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  quit: () => ipcRenderer.invoke("app:quit"),
  showDataFolder: () => ipcRenderer.invoke("app:show-data-folder"),
};
contextBridge.exposeInMainWorld("jobVaccum", api);
