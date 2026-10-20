import { contextBridge, ipcRenderer } from "electron";
import type { ConnectionState, JobVaccumApi, ServiceEvent } from "../shared/api";

// Sandboxed preload only requires Electron; do not import runtime local modules.
const api: JobVaccumApi = {
  getConnection: () => ipcRenderer.invoke("app:connection"),
  onConnectionChange(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: ConnectionState) => listener(state);
    ipcRenderer.on("app:connection-changed", receive);
    return () => ipcRenderer.removeListener("app:connection-changed", receive);
  },
  listJobs: (params) => ipcRenderer.invoke('jobs:list', params),
  getJobDetail: (params) => ipcRenderer.invoke('jobs:detail', params),
  scoreJobs: (params) => ipcRenderer.invoke('jobs:score', params),
  testModel: (params = {}) => ipcRenderer.invoke('model:test', params),
  cancelOperation: (params) => ipcRenderer.invoke('operations:cancel', params),
  setModelKey: (params) => ipcRenderer.invoke('credentials:set-model-key', params),
  deleteModelKey: () => ipcRenderer.invoke('credentials:delete-model-key'),
  getSettings: () => ipcRenderer.invoke('settings:get', {}),
  saveSettings: (params) => ipcRenderer.invoke('settings:save', params),
  saveDirection: (params) => ipcRenderer.invoke('directions:save', params),
  deleteDirection: (params) => ipcRenderer.invoke('directions:delete', params),
  reorderDirections: (params) => ipcRenderer.invoke('directions:reorder', params),
  getDraft: (params) => ipcRenderer.invoke('drafts:get', params),
  saveDraft: (params) => ipcRenderer.invoke('drafts:save', params),
  applyDraft: (params) => ipcRenderer.invoke('drafts:apply', params),
  previewRun: (params = {}) => ipcRenderer.invoke('runs:preview', params),
  startRun: (params = {}) => ipcRenderer.invoke('runs:start', params),
  listRuns: (params = {}) => ipcRenderer.invoke('runs:list', params),
  getRunDetail: (params) => ipcRenderer.invoke('runs:detail', params),
  stopRun: (params) => ipcRenderer.invoke('runs:stop', params),
  resumeRun: (params) => ipcRenderer.invoke('runs:resume', params),
  setProxyCredential: (params) => ipcRenderer.invoke('credentials:set-proxy', params),
  deleteProxyCredential: () => ipcRenderer.invoke('credentials:delete-proxy'),
  saveQuery: (params) => ipcRenderer.invoke('queries:save', params),
  deleteQuery: (params) => ipcRenderer.invoke('queries:delete', params),
  addApplication: (params) => ipcRenderer.invoke('applications:add', params),
  addApplications: (params) => ipcRenderer.invoke('applications:add-many', params),
  updateApplication: (params) => ipcRenderer.invoke('applications:update', params),
  setApplicationStatus: (params) => ipcRenderer.invoke('applications:set-status', params),
  removeApplications: (params) => ipcRenderer.invoke('applications:remove', params),
  restoreApplications: (params) => ipcRenderer.invoke('applications:restore', params),
  previewCleanup: (params) => ipcRenderer.invoke('cleanup:preview', params),
  executeCleanup: (params) => ipcRenderer.invoke('cleanup:execute', params),
  importSyntheticJobs: (params) => ipcRenderer.invoke('dev:import-synthetic', params),
  chooseCsvDestination: () => ipcRenderer.invoke('export:choose-csv-destination'),
  exportCsv: (params) => ipcRenderer.invoke('export:csv', params),
  showCsvInFinder: (params) => ipcRenderer.invoke('export:show-in-finder', params),
  onServiceEvent(listener) {
    const receive = (_event: Electron.IpcRendererEvent, event: ServiceEvent) => listener(event);
    ipcRenderer.on('app:service-event', receive);
    return () => ipcRenderer.removeListener('app:service-event', receive);
  },
  getStatus: () => ipcRenderer.invoke("app:status"),
  ping: (message) => ipcRenderer.invoke("app:ping", message),
  getDiagnostics: () => ipcRenderer.invoke("app:diagnostics"),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  quit: () => ipcRenderer.invoke("app:quit"),
  showDataFolder: () => ipcRenderer.invoke("app:show-data-folder"),
  openLink: (url) => ipcRenderer.invoke("app:open-link", url),
};
contextBridge.exposeInMainWorld("jobVaccum", api);
