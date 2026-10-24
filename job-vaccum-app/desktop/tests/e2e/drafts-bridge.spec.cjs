const { test, expect, _electron: electron } = require('@playwright/test');
const { rm } = require('node:fs/promises');
const path = require('node:path');
const { directory, quit } = require('./support.cjs');

const root = path.resolve(__dirname, '../..');
async function launch(dir) {
  const application = await electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/drafts-main.cjs'), `--data-dir=${dir}`], cwd: '/',
    env: { ...process.env, PATH: '/usr/bin:/bin' } });
  application.ownedProcess = application.process();
  const page = await application.firstWindow();
  await expect(page.locator('.sidebar-status')).toHaveAttribute('data-connection', 'ready');
  await page.evaluate(() => {
    window.draftEvents = [];
    window.jobVaccum.onServiceEvent(event => window.draftEvents.push(event));
  });
  return { application, page };
}
const call = (page, method, params) => page.evaluate(([name, input]) => window.jobVaccum[name](input), [method, params]);
async function ok(page, method, params) {
  const result = await call(page, method, params);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.result;
}
async function completed(page, operation_id, name) {
  await expect.poll(() => page.evaluate(id => window.draftEvents.find(e => e.data.operation_id === id), operation_id)).toMatchObject({ name });
  return page.evaluate(id => window.draftEvents.find(e => e.data.operation_id === id), operation_id);
}

test('M5 named bridge: input recovery, clarification, generation, apply, cancellation and restart', async () => {
  const dir = await directory();
  let application, page;
  try {
    ({ application, page } = await launch(dir));
    await ok(page, 'saveSettings', { retention_days: 0, auto_score_enabled: false,
      model: { protocol: 'chat_completions', base_url: 'https://example.invalid/v1', model_id: 'synthetic' } });
    const input = { text: '  Synthetic job search\n', conditions: {} };
    expect((await call(page, 'generateDraft', { kind: 'search', input })).error.code).toBe('AUTH_ERROR');
    expect(await ok(page, 'getDraft', { draft_kind: 'search' })).toEqual({ draft_kind: 'search', content: null, input });
    await ok(page, 'saveDraft', { draft_kind: 'rubric', content: '# Original rubric', input: { text: '' } });
    await ok(page, 'setModelKey', { key: 'synthetic-draft-key' });
    const before = await ok(page, 'getSettings');
    let accepted = await ok(page, 'generateDraft', { kind: 'search', input });
    const event = await completed(page, accepted.operation_id, 'drafts.generated');
    expect(event.data).toEqual({ operation_id: accepted.operation_id, draft_kind: 'search' });
    expect((await ok(page, 'getDraft', { draft_kind: 'search' })).content.clarification).toBe('Which role?');
    expect((await call(page, 'applyDraft', { draft_kind: 'search' })).error.code).toBe('VALIDATION_ERROR');
    accepted = await ok(page, 'generateDraft', { kind: 'search', input: { ...input, clarification_answer: 'Software' } });
    await completed(page, accepted.operation_id, 'drafts.generated');
    const search = await ok(page, 'getDraft', { draft_kind: 'search' });
    expect(search.content.directions[0].queries).toHaveLength(2);
    expect((await ok(page, 'getSettings')).directions).toEqual(before.directions);
    await ok(page, 'applyDraft', { draft_kind: 'search' });
    expect((await ok(page, 'getSettings')).directions[0].name).toBe('Software');
    accepted = await ok(page, 'generateDraft', { kind: 'rubric', input: { text: 'Synthetic resume', conditions: {} } });
    await completed(page, accepted.operation_id, 'drafts.generated');
    const rubric = await ok(page, 'getDraft', { draft_kind: 'rubric' });
    expect(rubric.content).toContain('# Synthetic rubric');
    expect((await ok(page, 'getSettings')).rubric).toBe(before.rubric);
    await ok(page, 'applyDraft', { draft_kind: 'rubric' });
    const applied = await ok(page, 'getSettings');
    expect(applied.rubric).toBe(rubric.content);
    expect(applied.auto_score_enabled).toBe(false);
    accepted = await ok(page, 'generateDraft', { kind: 'rubric', input: { text: 'slow synthetic resume', conditions: {} } });
    expect((await ok(page, 'getStatus')).operations).toContainEqual({
      operation_id: accepted.operation_id, kind: 'draft_generate', draft_kind: 'rubric', status: 'running',
    });
    await ok(page, 'cancelOperation', accepted);
    expect((await completed(page, accepted.operation_id, 'operation.failed')).data.error.code).toBe('CANCELLED');
    const cancelled = await ok(page, 'getDraft', { draft_kind: 'rubric' });
    expect(cancelled.content).toBe(rubric.content);
    expect(cancelled.input.text).toBe('slow synthetic resume');
    expect((await call(page, 'ping', 'still connected')).ok).toBe(true);
    const events = await page.evaluate(() => JSON.stringify(window.draftEvents));
    expect(events).not.toContain('synthetic-draft-key');
    expect(events).not.toContain('slow synthetic resume');
    await quit(application); application = null;
    ({ application, page } = await launch(dir));
    expect(await ok(page, 'getDraft', { draft_kind: 'search' })).toEqual(search);
    expect(await ok(page, 'getDraft', { draft_kind: 'rubric' })).toEqual(cancelled);
    expect((await ok(page, 'getStatus')).operations).toEqual([]);
  } finally {
    if (application) await quit(application);
    await rm(dir, { recursive: true, force: true });
  }
});
