const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const handlers = new Map();
const originalLoad = Module._load;
let available = true;
let broken = false;
const electron = {
  app: { isPackaged: false }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(value).map(byte => byte ^ 0xa5),
    decryptString: value => {
      if (broken) throw new Error('Synthetic private Keychain diagnostic');
      return Buffer.from(value).map(byte => byte ^ 0xa5).toString();
    },
  },
};
Module._load = function(name, ...rest) { return name === 'electron' ? electron : originalLoad.call(this, name, ...rest); };
const { registerBusinessIpc } = require('../dist/electron/main/business-ipc.js');
Module._load = originalLoad;

for (const failure of ['unavailable', 'decrypt']) {
  test(`unreadable key (${failure}) permits configuration and non-scoring runs, but preserves auth failures`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jv-business-ipc-'));
    const backend = new EventEmitter();
    const calls = [];
    let modelKey = null;
    let autoScore = false;
    let queryValid = true;
    backend.request = async (method, params) => {
      calls.push(method);
      if (method === 'internal.credentials') {
        if ('model_key' in params) modelKey = params.model_key;
        return { ok: true, result: { has_key: modelKey !== null, has_proxy_credentials: false } };
      }
      if (method === 'settings.get') return { ok: true, result: { auto_score_enabled: autoScore, rubric: 'Keep configuration', has_key: modelKey !== null } };
      if (method.startsWith('runs.')) {
        if (!queryValid) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Enable a query.', retryable: false } };
        const needsKey = method === 'runs.resume' ? params.run_id === 'original-scoring-snapshot' : autoScore;
        if (needsKey && !modelKey) return { ok: false, error: { code: 'AUTH_ERROR', message: 'Save a readable API key before scoring.', retryable: false } };
        return { ok: true, result: { run_id: 'synthetic-run' } };
      }
      throw new Error(`Unexpected business call: ${method}`);
    };
    const invoke = (name, params = {}) => handlers.get(name)({}, params);
    try {
      registerBusinessIpc(backend, () => null, () => {}, directory);
      assert.equal((await invoke('credentials:set-model-key', { key: 'synthetic-key' })).ok, true);
      const encrypted = await readFile(path.join(directory, 'model-key.enc'));
      available = failure !== 'unavailable';
      broken = failure === 'decrypt';
      const settings = await invoke('settings:get');
      assert.equal(settings.ok, true);
      assert.equal(settings.result.has_key, false);
      assert.equal(settings.result.rubric, 'Keep configuration');
      assert.equal(settings.result.model_key_error.code, 'AUTH_ERROR');
      assert.equal(modelKey, null);
      assert.equal(JSON.stringify(settings).includes('private Keychain'), false);
      assert.deepEqual(await readFile(path.join(directory, 'model-key.enc')), encrypted);
      for (const name of ['runs:preview', 'runs:start']) assert.equal((await invoke(name)).ok, true);
      assert.equal((await invoke('runs:resume', { run_id: 'original-disabled-snapshot' })).ok, true);
      const resume = await invoke('runs:resume', { run_id: 'original-scoring-snapshot' });
      assert.equal(resume.error.code, 'AUTH_ERROR');
      assert.match(resume.error.message, /Keychain/);
      autoScore = true;
      for (const name of ['runs:preview', 'runs:start']) {
        const result = await invoke(name);
        assert.equal(result.error.code, 'AUTH_ERROR');
        assert.match(result.error.message, /Keychain/);
      }
      const before = calls.length;
      for (const name of ['jobs:score', 'model:test']) assert.equal((await invoke(name)).error.code, 'AUTH_ERROR');
      assert.equal(calls.slice(before).some(name => name === 'jobs.score' || name === 'model.test'), false);
      autoScore = false;
      queryValid = false;
      assert.equal((await invoke('runs:preview')).error.code, 'VALIDATION_ERROR');
      await invoke('credentials:delete-model-key');
      const cleared = await invoke('settings:get');
      assert.equal(cleared.ok, true);
      assert.equal(cleared.result.model_key_error, undefined);
    } finally {
      available = true; broken = false;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('background preparation injects both credentials without a window and reports unreadable proxy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jv-background-ipc-'));
  const calls = [];
  const backend = new EventEmitter();
  backend.request = async (method, params) => {
    calls.push([method, params]);
    return { ok: true, result: { has_key: params.model_key != null, has_proxy_credentials: params.proxy_url != null } };
  };
  try {
    available = true; broken = false;
    const prepare = registerBusinessIpc(backend, () => null, () => {}, directory);
    await prepare();
    assert.deepEqual(calls, [
      ['internal.credentials', { proxy_url: null }], ['internal.credentials', { model_key: null }],
    ]);
    await handlers.get('credentials:set-proxy')({}, { url: 'http://synthetic:password@localhost:8080' });
    available = false;
    await assert.rejects(prepare(), /Proxy credentials could not be read/);
  } finally { available = true; broken = false; await rm(directory, { recursive: true, force: true }); }
});
