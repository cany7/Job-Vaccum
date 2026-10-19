import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ApiResult, ServiceEvent } from '../shared/api';
import { businessMethods } from '../shared/protocol';
import type { Backend } from './backend';

const invalid = (message: string): ApiResult<never> => ({ ok: false, error: { code: 'VALIDATION_ERROR', message, retryable: false } });

export function registerBusinessIpc(backend: Backend, getWindow: () => BrowserWindow | null,
  assertSender: (event: IpcMainInvokeEvent) => void, dataDir: string) {
  const destinations = new Map<string, string>();
  const exports = new Map<string, { path: string; operation_id?: string; complete: boolean }>();
  for (const [channel, method] of Object.entries(businessMethods)) {
    ipcMain.handle(channel, (event, params: Record<string, unknown>) => {
      assertSender(event);
      if (method === 'dev.import_synthetic' && app.isPackaged) return invalid('Synthetic fixtures are available only in development.');
      return backend.request(method, params);
    });
  }
  ipcMain.handle('export:choose-csv-destination', async (event) => {
    assertSender(event);
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: 'Export CSV', defaultPath: 'jobs.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { ok: true, result: null };
    const relative = path.relative(dataDir, result.filePath);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return invalid('Choose an export destination outside the application data directory.');
    }
    const token = randomUUID();
    destinations.set(token, result.filePath);
    return { ok: true, result: { destination_token: token } };
  });
  ipcMain.handle('export:csv', async (event, params: Record<string, unknown>) => {
    assertSender(event);
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || typeof params.destination_token !== 'string' || 'destination_path' in params) return invalid('Choose a CSV destination first.');
    const { destination_token, ...options } = params;
    const destination = destinations.get(destination_token);
    if (!destination) return invalid('The export destination token is invalid or has already been used.');
    destinations.delete(destination_token);
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
}
