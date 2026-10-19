import { safeStorage } from 'electron';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Backend } from './backend';
import type { ApiResult } from '../shared/api';

const unavailable = (): ApiResult<never> => ({ ok: false, error: { code: 'AUTH_ERROR',
  message: 'The API key could not be read or saved securely. Check Keychain access.', retryable: false } });

export function modelCredentials(backend: Backend, dataDir: string) {
  const file = path.join(dataDir, 'model-key.enc');
  let pending: Promise<unknown> = Promise.resolve();
  const ordered = <T>(work: () => Promise<T>) => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };
  const inject = async (): Promise<ApiResult<{ has_key: boolean }>> => {
    let encrypted: Buffer;
    try { encrypted = await readFile(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return backend.request('internal.credentials', { model_key: null });
    }
    if (!safeStorage.isEncryptionAvailable()) return unavailable();
    const result = await backend.request<{ has_key: boolean }>('internal.credentials', { model_key: safeStorage.decryptString(encrypted) });
    return result.ok ? { ok: true, result: { has_key: result.result.has_key } } : result;
  };
  return {
    inject: () => ordered(async () => {
      try {
        const result = await inject();
        if (result.ok || result.error.code !== 'AUTH_ERROR') return result;
      } catch { /* Report a controlled storage error after clearing stale memory. */ }
      try {
        const cleared = await backend.request('internal.credentials', { model_key: null });
        if (!cleared.ok) return cleared;
      } catch { return unavailable(); }
      return unavailable();
    }),
    set: (params: { key: string }) => ordered(async () => {
      if (!params || Object.keys(params).length !== 1 || typeof params.key !== 'string'
        || !params.key.trim() || /[\r\n]/.test(params.key)) {
        return { ok: false as const, error: { code: 'VALIDATION_ERROR', message: 'Enter a non-empty API key on one line.', retryable: false } };
      }
      try {
        if (!safeStorage.isEncryptionAvailable()) return unavailable();
        await writeFile(file, safeStorage.encryptString(params.key.trim()), { mode: 0o600 });
        return await inject();
      } catch { return unavailable(); }
    }),
    delete: () => ordered(async () => {
      try {
        await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        const result = await backend.request<{ has_key: boolean }>('internal.credentials', { model_key: null });
        return result.ok ? { ok: true as const, result: { has_key: result.result.has_key } } : result;
      } catch { return unavailable(); }
    }),
  };
}
