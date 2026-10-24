// Synthetic JSON Lines peer for transport failure tests. No network or business data.
const readline = require('node:readline');
const mode = process.argv[2];
const ready = { type: 'event', name: 'ready', seq: 1,
  data: { protocol_version: mode === 'incompatible' ? 2 : 1, app_version: 'test', schema_version: 1 } };
if (mode === 'never-ready') {
  setInterval(() => {}, 1000);
} else if (mode === 'startup-error') {
  console.error('BUSY: This data directory is already open.');
  process.exit(2);
} else {
  process.stdout.write(JSON.stringify(ready) + '\n');
  let starts = 0;
  if (mode === 'stubborn-child') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
  let outputs = [];
  let flushing = false;
  function flush() {
    if (flushing) return;
    flushing = true;
    setImmediate(() => {
      const output = Buffer.from(outputs.reverse().join(''));
      outputs = [];
      const split = output.indexOf(Buffer.from('中')) + 1;
      process.stdout.write(output.subarray(0, split));
      // Deliberate delay forces a decoder boundary inside the Unicode character.
      setTimeout(() => {
        process.stdout.write(output.subarray(split));
        flushing = false;
        if (outputs.length) flush();
      }, 10);
    });
  }
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (mode === 'start-timeout') {
      if (request.method === 'runs.start') {
        starts++;
        setTimeout(() => process.stdout.write(JSON.stringify({ type: 'response', id: request.id, ok: true,
          result: { run_id: 'accepted-once' } }) + '\n'), 150);
      } else {
        process.stdout.write(JSON.stringify({ type: 'response', id: request.id, ok: true,
          result: { active_run: { run_id: 'accepted-once' }, starts } }) + '\n');
      }
      return;
    }
    if (mode === 'stubborn-child') {
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, ok: true,
        result: { child_pid: child.pid } }) + '\n');
      return;
    }
    if (mode === 'owned-child') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { child_pid: child.pid } }) + '\n');
      setTimeout(() => process.exit(3), 30);
      return;
    }
    if (mode === 'exit') process.exit(3);
    if (mode === 'invalid') return process.stdout.write('invalid-json\n');
    if (mode === 'oversized') return process.stdout.write('x'.repeat(1024 * 1024 + 1));
    if (mode === 'timeout') {
      setTimeout(() => process.stdout.write(JSON.stringify({ type: 'response', id: request.id, ok: true, result: {} }) + '\n'), 150);
      return;
    }
    if (mode === 'wait-for-requests') return;
    if (mode === 'run-events') {
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { run_id: 'synthetic-run' } }) + '\n');
      for (const [seq, name, data] of [[2, 'run.updated', { run_id: 'synthetic-run', status: 'running', stage: 'retrieving' }],
        [3, 'run.stats', { run_id: 'synthetic-run', retrieval: { total: 1, active: 1 }, scoring: { total: 0, active: 0 } }]]) {
        process.stdout.write(JSON.stringify({ type: 'event', name, seq, data }) + '\n');
      }
      return;
    }
    outputs.push(JSON.stringify({ type: 'response', id: request.id, ok: true, result: request.params }) + '\n');
    flush();
  });
}
