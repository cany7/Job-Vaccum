const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
let available = true;
let broken = false;
const encryption = {
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(text).map(byte => byte ^ 0xa5),
  decryptString: bytes => {
    if (broken) throw new Error('Synthetic Keychain error with private diagnostic');
    return Buffer.from(bytes).map(byte => byte ^ 0xa5).toString();
  },
};
Module._load = function(name, ...rest) {
  return name === 'electron' ? { safeStorage: encryption } : originalLoad.call(this, name, ...rest);
};
const { modelCredentials } = require('../dist/electron/main/model-credentials.js');
Module._load = originalLoad;

test('model key encrypts, privately injects, reloads and deletes without disclosing secrets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jv-model-key-test-'));
  const calls = [];
  const backend = { request: async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { has_key: params.model_key !== null } };
  } };
  try {
    const store = modelCredentials(backend, directory);
    assert.deepEqual((await store.inject()).result, { has_key: false });
    for (const key of ['', '  ', 'secret\nheader']) {
      const result = await store.set({ key });
      assert.equal(result.error.code, 'VALIDATION_ERROR');
      assert.equal(JSON.stringify(result).includes('secret'), false);
    }
    const key = 'synthetic-only-for-test';
    assert.deepEqual((await store.set({ key })).result, { has_key: true });
    const encrypted = await readFile(path.join(directory, 'model-key.enc'));
    assert.equal(encrypted.includes(Buffer.from(key)), false);
    const reloaded = modelCredentials(backend, directory);
    await reloaded.inject();
    assert.deepEqual(calls.at(-1), { method: 'internal.credentials', params: { model_key: key } });
    available = false;
    assert.equal((await reloaded.set({ key: 'replacement' })).error.code, 'AUTH_ERROR');
    assert.equal((await reloaded.inject()).error.code, 'AUTH_ERROR');
    assert.deepEqual(await readFile(path.join(directory, 'model-key.enc')), encrypted);
    available = true;
    broken = true;
    const failed = await reloaded.inject();
    assert.equal(failed.error.code, 'AUTH_ERROR');
    assert.equal(JSON.stringify(failed).includes('private diagnostic'), false);
    broken = false;
    assert.equal((await store.delete()).result.has_key, false);
    await assert.rejects(readFile(path.join(directory, 'model-key.enc')), { code: 'ENOENT' });
  } finally {
    available = true; broken = false;
    await rm(directory, { recursive: true, force: true });
  }
});
