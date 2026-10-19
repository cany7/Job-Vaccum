const { test, expect } = require('@playwright/test');
const http = require('node:http');
const { once } = require('node:events');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { packaged, directory, seed, launch, quit, jobId } = require('./support.cjs');

test('M3 named model/key/score bridge uses real backend and local HTTP', async () => {
  test.skip(!!packaged, 'M3 installed package has not been built.');
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, headers: request.headers, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"score":0,"reason":"Synthetic zero."}' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dataDir = await directory();
  const base_url = `http://127.0.0.1:${server.address().port}/custom/v1`;
  await seed(dataDir, [['dev.import_synthetic', { count: 1 }], ['settings.save', {
    retention_days: 0, auto_score_enabled: false, rubric: 'Synthetic rubric.',
    model: { protocol: 'chat_completions', base_url, model_id: 'synthetic', temperature: 0 },
  }]]);
  let application;
  try {
    const launched = await launch(dataDir);
    application = launched.application;
    const { page } = launched;
    await page.evaluate(() => {
      window.m3Events = [];
      window.jobVaccum.onServiceEvent(event => window.m3Events.push(event));
    });
    const saved = await page.evaluate(() => window.jobVaccum.setModelKey({ key: ' \tsynthetic-only-for-test\t ' }));
    expect(saved).toEqual({ ok: true, result: { has_key: true } });
    const encrypted = await readFile(path.join(dataDir, 'model-key.enc'));
    expect(encrypted.includes(Buffer.from('synthetic-only-for-test'))).toBe(false);
    const tested = await page.evaluate(() => window.jobVaccum.testModel());
    expect(tested.ok).toBe(true);
    await expect.poll(() => page.evaluate(id => window.m3Events.some(e => e.name === 'model.test.completed' && e.data.operation_id === id), tested.result.operation_id)).toBe(true);
    const scored = await page.evaluate(id => window.jobVaccum.scoreJobs({ job_ids: [id] }), jobId(0));
    expect(scored.result.job_count).toBe(1);
    await expect.poll(() => page.evaluate(async id => (await window.jobVaccum.getJobDetail({ job_id: id })).result.score_state, jobId(0)), { timeout: 10000 }).toBe('succeeded');
    const detail = await page.evaluate(id => window.jobVaccum.getJobDetail({ job_id: id }), jobId(0));
    expect(detail.result.score).toBe(0);
    expect(detail.result.score_reason).toBe('Synthetic zero.');
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.path === '/custom/v1/chat/completions' && c.headers.authorization === 'Bearer synthetic-only-for-test' && c.body.temperature === 0)).toBe(true);
    const corrupt = Buffer.from('synthetic-invalid-encrypted-data');
    await writeFile(path.join(dataDir, 'model-key.enc'), corrupt);
    const readableSettings = await page.evaluate(() => window.jobVaccum.getSettings());
    expect(readableSettings.ok).toBe(true);
    expect(readableSettings.result.has_key).toBe(false);
    expect(readableSettings.result.model_key_error.code).toBe('AUTH_ERROR');
    expect(readableSettings.result.rubric).toBe('Synthetic rubric.');
    await page.evaluate(() => window.jobVaccum.saveSettings({
      cities: [{ location: 'Chicago', distance_miles: 25, enabled: true }], platforms: ['linkedin'],
    }));
    expect((await page.evaluate(() => window.jobVaccum.previewRun())).ok).toBe(true);
    await page.evaluate(() => window.jobVaccum.saveSettings({ auto_score_enabled: true }));
    expect((await page.evaluate(() => window.jobVaccum.previewRun())).error.code).toBe('AUTH_ERROR');
    expect((await page.evaluate(() => window.jobVaccum.testModel())).error.code).toBe('AUTH_ERROR');
    expect((await page.evaluate(id => window.jobVaccum.scoreJobs({ job_ids: [id] }), jobId(0))).error.code).toBe('AUTH_ERROR');
    expect(await readFile(path.join(dataDir, 'model-key.enc'))).toEqual(corrupt);
    expect(calls).toHaveLength(2);
    expect(await page.evaluate(() => window.jobVaccum.deleteModelKey())).toEqual({ ok: true, result: { has_key: false } });
    expect((await page.evaluate(() => window.jobVaccum.getSettings())).result.has_key).toBe(false);
    expect(await page.evaluate(() => JSON.stringify(window.m3Events))).not.toContain('synthetic-only-for-test');
    expect(page.errors).toEqual([]);
  } finally {
    if (application) await quit(application);
    await new Promise(resolve => server.close(resolve));
  }
});
