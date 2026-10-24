import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ApiError, ApiResult, ServiceEvent } from '../shared/api';
import { businessMethods } from '../shared/protocol';
import type { Backend } from './backend';
import { proxyCredentials } from './proxy-credentials';
import { modelCredentials } from './model-credentials';

const invalid = (message: string): ApiResult<never> => ({ ok: false, error: { code: 'VALIDATION_ERROR', message, retryable: false } });

async function resolveCsvDestination(dataDir: string, destination: string): Promise<string> {
  const dataRoot = await realpath(dataDir);
  // A new filename has no realpath yet; resolve its existing parent instead.
  const entry = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const resolved = entry ? await realpath(destination)
    : path.join(await realpath(path.dirname(destination)), path.basename(destination));
  const relative = path.relative(dataRoot, resolved);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Destination is inside application data.');
  }
  return resolved;
}

export function registerBusinessIpc(backend: Backend, getWindow: () => BrowserWindow | null,
  assertSender: (event: IpcMainInvokeEvent) => void, dataDir: string) {
  const credentials = proxyCredentials(backend, dataDir);
  const modelKey = modelCredentials(backend, dataDir);
  ipcMain.handle('credentials:set-model-key', (event, params: { key: string }) => {
    assertSender(event);
    return modelKey.set(params);
  });
  ipcMain.handle('credentials:delete-model-key', (event) => {
    assertSender(event);
    return modelKey.delete();
  });
  ipcMain.handle('credentials:set-proxy', (event, params: { url: string }) => {
    assertSender(event);
    return credentials.set(params);
  });
  ipcMain.handle('credentials:delete-proxy', (event) => {
    assertSender(event);
    return credentials.delete();
  });
  const destinations = new Map<string, string>();
  const exports = new Map<string, { path: string; operation_id?: string; complete: boolean }>();
  for (const [channel, method] of Object.entries(businessMethods)) {
    ipcMain.handle(channel, async (event, params: Record<string, unknown>) => {
      assertSender(event);
      if (method === 'dev.import_synthetic' && app.isPackaged) return invalid('Synthetic fixtures are available only in development.');
      if (['runs.start', 'runs.resume', 'runs.preview', 'settings.get'].includes(method)) {
        const injected = await credentials.inject();
        if (!injected.ok) return injected;
      }
      let modelKeyError: ApiError | undefined;
      if (['runs.start', 'runs.resume', 'runs.preview', 'settings.get', 'jobs.score', 'model.test'].includes(method)) {
        const injected = await modelKey.inject();
        if (!injected.ok) {
          if (injected.error.code !== 'AUTH_ERROR' || ['jobs.score', 'model.test'].includes(method)) return injected;
          modelKeyError = injected.error;
        }
      }
      const result = await backend.request<Record<string, unknown>>(method, params);
      if (modelKeyError && method === 'settings.get' && result.ok) {
        return { ok: true, result: { ...result.result, model_key_error: modelKeyError } };
      }
      // The service decides from the current settings or original resume
      // snapshot whether a key is needed; unrelated validation still wins.
      if (modelKeyError && !result.ok && result.error.code === 'AUTH_ERROR') return { ok: false, error: modelKeyError };
      return result;
    });
  }
  ipcMain.handle('export:choose-csv-destination', async (event) => {
    assertSender(event);
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: 'Export CSV', defaultPath: 'jobs.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { ok: true, result: null };
    let destination: string;
    try {
      destination = await resolveCsvDestination(dataDir, result.filePath);
    } catch {
      return invalid('Choose a resolvable export destination outside the application data directory.');
    }
    const token = randomUUID();
    destinations.set(token, destination);
    return { ok: true, result: { destination_token: token } };
  });
  ipcMain.handle('export:csv', async (event, params: Record<string, unknown>) => {
    assertSender(event);
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || typeof params.destination_token !== 'string' || 'destination_path' in params) return invalid('Choose a CSV destination first.');
    const { destination_token, ...options } = params;
    let destination = destinations.get(destination_token);
    if (!destination) return invalid('The export destination token is invalid or has already been used.');
    destinations.delete(destination_token);
    try {
      destination = await resolveCsvDestination(dataDir, destination);
    } catch {
      return invalid('Choose a resolvable export destination outside the application data directory.');
    }
    const result = await backend.request<{ operation_id: string }>('export.csv', { ...options, destination_path: destination });
    if (result.ok) exports.set(destination_token, { path: destination, operation_id: result.result.operation_id, complete: false });
    return result;
  });
  ipcMain.handle('export:show-in-finder', (event, params: { destination_token?: unknown }) => {
    assertSender(event);
    const record = typeof params?.destination_token === 'string' ? exports.get(params.destination_token) : undefined;
    if (!record?.complete) return invalid('Only a completed export from this session can be shown.');
    shell.showItemInFolder(record.path);
    return { ok: true, result: { shown: true } };
  });
  backend.on('service-event', (event: ServiceEvent) => {
    if (event.name === 'operation.completed' || event.name === 'operation.failed') {
      for (const [token, record] of exports) {
        if (record.operation_id === event.data.operation_id) {
          if (event.name === 'operation.completed') record.complete = true;
          else exports.delete(token);
        }
      }
    }
    getWindow()?.webContents.send('app:service-event', event);
  });
  // Background schedules also need credentials when no renderer has requested settings.
  return async () => {
    const proxy = await credentials.inject();
    if (!proxy.ok) throw new Error(proxy.error.message);
    const model = await modelKey.inject();
    // AUTH_ERROR clears the unreadable model key; scoring validation records
    // the failure, while schedules with automatic scoring off remain runnable.
    if (!model.ok && model.error.code !== 'AUTH_ERROR') throw new Error(model.error.message);
  };

}
