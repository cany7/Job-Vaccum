import { safeStorage } from 'electron';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Backend } from './backend';
import type { ApiResult } from '../shared/api';

const invalid = (): ApiResult<never> => ({ ok: false, error: { code: 'VALIDATION_ERROR',
  message: 'Enter an http, https or socks5 proxy origin with an explicit port.', retryable: false } });
const unavailable = (): ApiResult<never> => ({ ok: false, error: { code: 'AUTH_ERROR',
  message: 'Proxy credentials could not be read or saved securely. Check Keychain access.', retryable: false } });
export function proxyCredentials(backend: Backend, dataDir: string) {
  const file = path.join(dataDir, 'proxy-credentials.enc');
  // This promise serializes credential edits and injection without writing a second copy.
  let pending: Promise<unknown> = Promise.resolve();
  const ordered = <T>(work: () => Promise<T>) => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };
  const inject = async () => {
    let encrypted: Buffer;
    try { encrypted = await readFile(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return backend.request<{ has_proxy_credentials: boolean }>('internal.credentials', { proxy_url: null });
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable');
    return backend.request<{ has_proxy_credentials: boolean }>('internal.credentials', { proxy_url: safeStorage.decryptString(encrypted) });
  };
  return {
    inject: () => ordered(async () => { try { return await inject(); } catch { return unavailable(); } }),
    set: (params: { url: string }) => ordered(async () => {
      try {
        if (!params || Object.keys(params).length !== 1 || typeof params.url !== 'string') return invalid();
        let url: URL;
        try { url = new URL(params.url); } catch { return invalid(); }
        const authority = params.url.split('://')[1]?.split('/')[0]?.split('@').at(-1);
        if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || !/:\d+$/.test(authority ?? '')
          || !['', '/'].includes(url.pathname) || url.search || url.hash) return invalid();
        if (!safeStorage.isEncryptionAvailable()) return unavailable();
        await writeFile(file, safeStorage.encryptString(params.url), { mode: 0o600 });
        return await inject();
      } catch { return unavailable(); }
    }),
    delete: () => ordered(async () => {
      try {
        await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        return await backend.request<{ has_proxy_credentials: boolean }>('internal.credentials', { proxy_url: null });
      } catch { return unavailable(); }
    }),
  };
}
