import type { ApiError, ApiResult } from '../shared/api';
import type { Method } from '../shared/protocol';
import type { Backend } from './backend';
import { proxyCredentials } from './proxy-credentials';
import { modelCredentials } from './model-credentials';

export type BusinessCall = (method: Method, params?: Record<string, unknown>) => Promise<ApiResult<unknown>>;

/** Private main-only entry point; IPC and MCP validate their own callers. */
export function createBusinessCaller(backend: Backend, dataDir: string) {
  const credentials = proxyCredentials(backend, dataDir);
  const modelKey = modelCredentials(backend, dataDir);
  const call: BusinessCall = async (method, params = {}) => {
    if (['runs.start', 'runs.resume', 'runs.preview', 'schedules.preview', 'settings.get'].includes(method)) {
      const injected = await credentials.inject();
      if (!injected.ok) return injected;
    }
    let modelKeyError: ApiError | undefined;
    if (['runs.start', 'runs.resume', 'runs.preview', 'schedules.preview', 'settings.get', 'jobs.score', 'model.test'].includes(method)) {
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
    if (modelKeyError && !result.ok && result.error.code === 'AUTH_ERROR') return { ok: false, error: modelKeyError };
    return result;
  };
  const prepareBackground = async () => {
    const proxy = await credentials.inject();
    if (!proxy.ok) throw new Error(proxy.error.message);
    const model = await modelKey.inject();
    if (!model.ok && model.error.code !== 'AUTH_ERROR') throw new Error(model.error.message);
  };
  return { call, credentials, modelKey, prepareBackground };
}
