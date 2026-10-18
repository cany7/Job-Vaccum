// No renderer/window: verifies actual Electron main -> Python stdio only.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const assert = require('node:assert/strict');
const path = require('node:path');

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const frozen = args.includes('--backend');
const executable = value(frozen ? '--backend' : '--python');
const dataDir = value('--data-dir');
assert(executable && path.isAbsolute(executable), 'Provide --backend or --python absolute path');
assert(dataDir && path.isAbsolute(dataDir), 'Provide --data-dir absolute path');

app.whenReady().then(() => {
  const child = spawn(executable, [...(frozen ? [] : ['-m', 'job_vaccum']), '--data-dir', dataDir], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let ready = false;
  const responses = new Map();
  const timeout = setTimeout(() => fail(new Error('Backend smoke timeout')), 60000);
  function fail(error) {
    console.error(error.message, stderr);
    child.kill('SIGKILL');
    clearTimeout(timeout);
    app.exit(1);
  }
  child.on('error', fail);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.stdout.on('data', chunk => {
    try {
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (!ready) {
          assert.equal(message.name, 'ready');
          assert.equal(message.seq, 1);
          assert.equal(message.data.protocol_version, 1);
          assert.equal(message.data.schema_version, 1);
          ready = true;
          const ping = Buffer.from(JSON.stringify({ type: 'request', id: 'ping', method: 'app.ping', params: { message: '合成 🧪' } }) + '\n');
          const split = ping.indexOf(Buffer.from('合')) + 1;
          child.stdin.write(ping.subarray(0, split));
          setTimeout(() => {
            child.stdin.write(Buffer.concat([ping.subarray(split), Buffer.from(
              '{"type":"request","id":"status","method":"app.status"}\n' +
              '{"type":"request","id":"error","method":"unsupported"}\n' +
              '{"type":"request","id":"diagnostics","method":"app.diagnostics"}\n'
            )]));
          }, 20);
        } else {
          assert.equal(message.type, 'response');
          assert(!responses.has(message.id), 'Duplicate response');
          responses.set(message.id, message);
          if (responses.size === 4) {
            assert.equal(responses.get('ping').result.message, '合成 🧪');
            assert.equal(responses.get('status').result.active_run, null);
            assert.equal(responses.get('error').error.code, 'NOT_FOUND');
            const diagnostic = responses.get('diagnostics');
            assert.equal(diagnostic.ok, true);
            assert.equal(diagnostic.result.frozen, frozen);
            assert.equal(diagnostic.result.machine, 'arm64');
            assert.equal(diagnostic.result.jobspy_commit, '1988484ac76ff9ae57784750346842e967e8ba10');
            assert.equal(diagnostic.result.storage.read_write, true);
            console.log(JSON.stringify({ electron: process.versions.electron, ...diagnostic.result }));
            child.stdin.end();
          }
        }
      }
    } catch (error) { fail(error); }
  });
  child.on('exit', code => {
    clearTimeout(timeout);
    try {
      assert.equal(code, 0);
      assert.equal(responses.size, 4);
      assert.equal(buffer, '');
      console.log('PASS: Electron/Python ready, fragmented UTF-8, batched requests, error, native imports, SQLite, EOF exit');
      app.exit(0);
    } catch (error) { fail(error); }
  });
});
