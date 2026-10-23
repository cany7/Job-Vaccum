const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ScheduleClock } = require('../dist/electron/main/schedule-clock.js');

test('virtual main clock: startup, regular tick, suspend/resume, delayed wake and stop', async () => {
  let now = 1000, timer;
  const calls = [], errors = [];
  const clock = new ScheduleClock(async reason => { calls.push(reason); return { ok: true }; },
    error => errors.push(error), () => now, fn => { timer = fn; return 1; }, () => { timer = undefined; });
  await clock.start();
  assert.deepEqual(calls, ['app_closed']);
  now += 1000; timer(); await clock.pending;
  assert.equal(calls.at(-1), undefined);
  clock.suspend(); assert.equal(timer, undefined);
  now += 3 * 86400000; await clock.resume();
  assert.equal(calls.at(-1), 'asleep');
  now += 10000; timer(); await clock.pending;
  assert.equal(calls.at(-1), 'asleep');
  clock.stop(); assert.equal(timer, undefined);
  await clock.resume(); assert.equal(calls.length, 4);
  assert.deepEqual(errors, []);
});

test('clock checks serialize; a command failure stops the clock without replay', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const errors = [];
  const clock = new ScheduleClock(async () => {
    calls++; await pending;
    return { ok: false, error: { message: 'Synthetic clock failure' } };
  }, message => errors.push(message));
  const started = clock.start();
  const resumed = clock.resume();
  await Promise.resolve(); assert.equal(calls, 1);
  release(); await Promise.all([started, resumed]);
  assert.equal(calls, 1);
  assert.deepEqual(errors, ['Synthetic clock failure']);
});

test('quitting during an in-flight check does not display a clock error', async () => {
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const errors = [];
  const clock = new ScheduleClock(() => result, error => errors.push(error));
  const started = clock.start();
  await Promise.resolve();
  clock.stop();
  release({ ok: false, error: { message: 'Job Vaccum is quitting.' } });
  await started;
  assert.deepEqual(errors, []);
});
