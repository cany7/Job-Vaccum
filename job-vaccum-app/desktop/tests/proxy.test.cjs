const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Replace only Electron's OS encryption boundary. No Keychain prompts/credentials.
const originalLoad = Module._load;
let available = true;
const encryption = {
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(text).map(byte => byte ^ 0xa5),
  decryptString: bytes => Buffer.from(bytes).map(byte => byte ^ 0xa5).toString(),
};
Module._load = function(name, ...rest) {
  return name === 'electron' ? { safeStorage: encryption } : originalLoad.call(this, name, ...rest);
};
const { proxyCredentials } = require('../dist/electron/main/proxy-credentials.js');
Module._load = originalLoad;

test('proxy credentials encrypt on disk, privately inject, reload and delete', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jv-credential-test-'));
  const calls = [];
  const backend = { request: async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { has_proxy_credentials: params.proxy_url !== null } };
  } };
  try {
    const store = proxyCredentials(backend, directory);
    const invalid = await store.set({ url: 'http://user:secret@localhost:8080/unsupported-path' });
    assert.equal(invalid.error.code, 'VALIDATION_ERROR');
    assert.equal(JSON.stringify(invalid).includes('secret'), false);
    await store.inject();
    assert.equal(calls.at(-1).params.proxy_url, null);
    const url = 'http://synthetic:only-for-test@localhost:8888';
    assert.equal((await store.set({ url })).ok, true);
    const encrypted = await readFile(path.join(directory, 'proxy-credentials.enc'));
    assert.equal(encrypted.includes(Buffer.from('only-for-test')), false);
    const reloaded = proxyCredentials(backend, directory);
    await reloaded.inject();
    assert.equal(calls.at(-1).method, 'internal.credentials');
    assert.equal(calls.at(-1).params.proxy_url, url);
    available = false;
    const refused = await reloaded.set({ url: 'http://other:secret@localhost:8888' });
    assert.equal(refused.error.code, 'AUTH_ERROR');
    assert.deepEqual(await readFile(path.join(directory, 'proxy-credentials.enc')), encrypted);
    available = true;
    assert.equal((await store.delete()).result.has_proxy_credentials, false);
    await assert.rejects(readFile(path.join(directory, 'proxy-credentials.enc')), { code: 'ENOENT' });
  } finally { available = true; await rm(directory, { recursive: true, force: true }); }
});
