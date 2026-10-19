const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const { Backend } = require('../dist/electron/main/backend.js');

function peer(mode, options = {}) {
  return new Backend({ executable: process.execPath, args: [path.join(__dirname, 'protocol-peer.cjs'), mode],
    dataDir: __dirname, ...options });
}
async function ready(backend) {
  if (backend.state.phase === 'starting') await once(backend, 'state');
  return backend.state;
}

test('streaming Unicode and concurrent ids, then graceful EOF', { timeout: 5000 }, async () => {
  const backend = peer('echo');
  try {
    assert.equal((await ready(backend)).phase, 'ready');
    const results = await Promise.all(['中文🙂', 'second'].map(message => backend.request('app.ping', { message })));
    assert.deepEqual(results.map(r => r.result.message), ['中文🙂', 'second']);
  } finally { await backend.stop(); }
});

for (const mode of ['incompatible', 'startup-error', 'never-ready']) {
  test(`${mode} produces visible startup failure`, { timeout: 15_000 }, async () => {
    const backend = peer(mode, { startupMs: 1000 });
    try {
      assert.equal((await ready(backend)).phase, 'failed');
      if (mode === 'startup-error') assert.match(backend.state.message, /BUSY/);
      assert.equal((await backend.request('app.status')).ok, false);
    } finally { await backend.stop(); }
  });
}

for (const mode of ['invalid', 'oversized', 'exit']) {
  test(`${mode} settles outstanding request without hanging`, { timeout: 5000 }, async () => {
    const backend = peer(mode);
    try {
      await ready(backend);
      const result = await backend.request('app.status');
      assert.equal(result.ok, false);
      assert.ok(['failed', 'exited'].includes(backend.state.phase));
    } finally { await backend.stop(); }
  });
}

test('timeout ignores late response and leaves connection usable without replay', { timeout: 5000 }, async () => {
  const backend = peer('timeout', { requestMs: 30 });
  try {
    await ready(backend);
    const result = await backend.request('app.status');
    assert.equal(result.error.code, 'TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(backend.state.phase, 'ready');
  } finally { await backend.stop(); }
});

test('quit settles pending calls and closes owned service', { timeout: 5000 }, async () => {
  const backend = peer('wait-for-requests');
  await ready(backend);
  const request = backend.request('app.status');
  await backend.stop();
  assert.equal((await request).error.code, 'CANCELLED');
});
