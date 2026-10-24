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


test('run notifications pass through transport after accepted start', { timeout: 5000 }, async () => {
  const backend = peer('run-events');
  try {
    await ready(backend);
    const events = [];
    let finish;
    const received = new Promise(resolve => { finish = resolve; });
    backend.on('service-event', event => { events.push(event); if (events.length === 2) finish(); });
    assert.equal((await backend.request('runs.start')).result.run_id, 'synthetic-run');
    await received;
    assert.deepEqual(events.map(event => event.name), ['run.updated', 'run.stats']);
    assert.equal(backend.state.phase, 'ready');
  } finally { await backend.stop(); }
});


test('service crash terminates its owned child even when that child holds stdio', { timeout: 5000 }, async () => {
  const backend = peer('owned-child');
  try {
    await ready(backend);
    const closed = once(backend, 'closed');
    const result = await backend.request('app.status');
    assert.ok(result.result.child_pid > 0);
    await closed;
    assert.equal(backend.state.phase, 'exited');
    let alive = true;
    for (let index = 0; index < 20 && alive; index++) {
      try { process.kill(result.result.child_pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
      catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false);
  } finally { await backend.stop(); }
});


test('timed-out start is queried without creating another run', { timeout: 5000 }, async () => {
  const backend = peer('start-timeout', { requestMs: 30 });
  try {
    await ready(backend);
    assert.equal((await backend.request('runs.start')).error.code, 'TIMEOUT');
    const status = await backend.request('app.status');
    assert.equal(status.result.active_run.run_id, 'accepted-once');
    assert.equal(status.result.starts, 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await backend.request('app.status')).result.starts, 1);
  } finally { await backend.stop(); }
});


test('quit kills a service and child ignoring EOF and SIGTERM within the bound', { timeout: 15_000 }, async () => {
  const backend = peer('stubborn-child');
  try {
    await ready(backend);
    const response = await backend.request('app.status');
    const pid = response.result.child_pid;
    const before = performance.now();
    const first = backend.stop();
    assert.equal(backend.stop(), first);
    await first;
    assert.ok(performance.now() - before < 13_000);
    let alive = true;
    for (let index = 0; index < 50 && alive; index++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
      catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false);
  } finally { await backend.stop(); }
});
