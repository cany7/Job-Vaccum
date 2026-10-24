// M4: kill the actual Electron owner during a synthetic, never-ending model call.
// No window, keychain, provider, scraper network, or personal data is involved.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Backend } = require('../desktop/dist/electron/main/backend.js');
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const python = argument('--python');
const dataDir = argument('--data-dir');
const fixture = path.resolve(__dirname, '../backend/tests/recovery_peer.py');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(mode) {
  const backend = new Backend({ executable: python, args: [fixture, mode], dataDir });
  if (backend.state.phase === 'starting') await once(backend, 'state');
  assert.equal(backend.state.phase, 'ready');
  return backend;
}
async function call(backend, method, params = {}) {
  const response = await backend.request(method, params);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
async function until(predicate, timeout = 14_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('Recovery smoke deadline exceeded');
}

async function owner() {
  const backend = await start('hang_model');
  await call(backend, 'internal.credentials', { model_key: 'synthetic-key' });
  await call(backend, 'settings.save', { auto_score_enabled: true, retention_days: 0,
    rubric: 'Synthetic rubric', cities: [{ location: 'Chicago', distance_miles: 25, enabled: true }],
    platforms: ['linkedin'], model: { protocol: 'chat_completions', base_url: 'http://127.0.0.1:1', model_id: 'fake' } });
  const direction = await call(backend, 'directions.save', { name: 'Synthetic' });
  await call(backend, 'queries.save', { direction_id: direction.id, expression: 'engineer' });
  const { run_id } = await call(backend, 'runs.start');
  await until(async () => (await call(backend, 'runs.detail', { run_id })).stats.scoring.active === 1);
  // ChildProcess is inspected only by this test, not exposed through product IPC.
  process.stdout.write(JSON.stringify({ owner_ready: true, run_id, service_pid: backend.child.pid }) + '\n');
}

async function check() {
  fs.mkdirSync(dataDir, { recursive: true });
  assert.equal(fs.readdirSync(dataDir).length, 0, 'Use a fresh, empty test data directory');
  const child = spawn(process.execPath, [__filename, '--owner', '--python', python, '--data-dir', dataDir],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let info, buffer = '', stderr = '', restored;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const message = JSON.parse(line); if (message.owner_ready) info = message; } catch {}
    }
  });
  try {
    await until(() => { if (child.exitCode !== null) throw new Error(stderr); return info; });
    const before = performance.now();
    child.kill('SIGKILL');
    await once(child, 'exit');
    await until(() => {
      try { process.kill(info.service_pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
    const elapsed = performance.now() - before;
    restored = await start('normal');
    const detail = await call(restored, 'runs.detail', { run_id: info.run_id });
    assert.equal(detail.status, 'interrupted');
    assert.equal(detail.stats.scoring.active, 0);
    assert.equal(detail.stats.retrieval.succeeded, 1);
    await call(restored, 'internal.credentials', { model_key: 'synthetic-corrected-key' });
    await call(restored, 'runs.resume', { run_id: info.run_id });
    await until(async () => (await call(restored, 'runs.detail', { run_id: info.run_id })).status === 'succeeded');
    const recovered = await call(restored, 'runs.detail', { run_id: info.run_id });
    assert.equal(recovered.stats.scoring.succeeded, 2);
    assert.equal(recovered.tasks.find(task => task.kind === 'retrieval').attempt_count, 1);
    console.log(JSON.stringify({ passed: true, owner: 'Electron SIGKILL', service_exit_ms: Math.round(elapsed),
      recovered_status: recovered.status, scores: recovered.stats.scoring.succeeded }));
  } finally {
    child.kill('SIGKILL');
    if (restored) await restored.stop();
    if (info) { try { process.kill(-info.service_pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
}
app.whenReady().then(async () => {
  try {
    if (process.argv.includes('--owner')) { await owner(); return; }
    await check();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
