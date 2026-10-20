// M3 renderer: Settings › Model, the rubric, the Score menu, details Score and
// scoring runs in Runs. A local HTTP server stands in for the model service; all
// jobs are synthetic fixtures. The service spaces model requests ~6 s apart
// (RPM 10), so the scoring test keeps its request count small.
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const { once } = require('node:events');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { packaged, fixture, directory, seed, launch, quit, nav, view, rows, row, toast } = require('./support.cjs');

const title = i => fixture(i).title;
const settingsSection = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name });
const scoreButton = page => page.locator('.topbar-actions').getByRole('button', { name: 'Score' });

/** Chat Completions stand-in: scores 7, except jobs whose title is listed in `fail` (HTTP 400, not retried). */
async function modelServer({ fail = [], hold = false } = {}) {
  const calls = [];
  const waiting = [];
  const release = () => {
    hold = false;
    waiting.splice(0).forEach(resolve => resolve());
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = JSON.stringify(body);
    calls.push({ path: request.url, headers: request.headers, body, text });
    if (hold) await new Promise(resolve => waiting.push(resolve));
    if (body.model === 'denied-model') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic auth failure' } }));
      return;
    }
    if (fail.some(name => text.includes(name))) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic bad request' } }));
      return;
    }
    const content = text.includes('Reply with OK') ? 'OK' : JSON.stringify({ score: 7, reason: 'Synthetic seven.' });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    calls, release, base: `http://127.0.0.1:${server.address().port}/custom/v1`,
    close: () => { release(); return new Promise(resolve => server.close(resolve)); },
  };
}

test('Model test results follow the tested configuration and saved key', async () => {
  test.skip(!!packaged, 'M3 installed package has not been built.');
  test.setTimeout(60_000);
  const model = await modelServer({ hold: true });
  const dataDir = await directory();
  await seed(dataDir, [['settings.save', {
    retention_days: 0, auto_score_enabled: false,
    model: { protocol: 'chat_completions', base_url: model.base, model_id: 'synthetic' },
  }]]);
  const { application, page } = await launch(dataDir);
  try {
    await nav(page, 'Settings').click();
    await settingsSection(page, 'Model').click();
    await page.getByLabel('API key').fill('synthetic-ui-key');
    await page.getByRole('button', { name: 'Save key' }).click();
    const testButton = page.getByRole('button', { name: 'Test connection' });
    await expect(testButton).toBeEnabled();
    await testButton.click();
    await expect.poll(() => model.calls.length).toBe(1);

    // The old model's success must not certify fields edited while it was waiting.
    await page.getByLabel('Model ID').fill('denied-model');
    model.release();
    await expect(testButton).toBeEnabled();
    await expect(page.getByText('Connected. The model replied.')).toHaveCount(0);
    expect(model.calls[0].body.model).toBe('synthetic');
    await testButton.click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't connect" })).toContainText('HTTP 401', { timeout: 20_000 });

    // A later unchanged test still reports success; deleting its key invalidates it.
    await page.getByLabel('Model ID').fill('synthetic');
    await testButton.click();
    await expect(page.getByText('Connected. The model replied.')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Remove key' }).click();
    await expect(testButton).toBeDisabled();
    await expect(page.getByText('Connected. The model replied.')).toHaveCount(0);
    expect(page.errors).toEqual([]);
  } finally {
    model.release();
    await quit(application);
    await model.close();
  }
});

test('Stopped scoring leaves pending jobs available to score from details', async () => {
  test.skip(!!packaged, 'M3 installed package has not been built.');
  test.setTimeout(60_000);
  const model = await modelServer({ hold: true });
  const dataDir = await directory();
  await seed(dataDir, [['dev.import_synthetic', { count: 2 }], ['settings.save', {
    retention_days: 0, auto_score_enabled: false, rubric: 'Synthetic rubric.',
    model: { protocol: 'chat_completions', base_url: model.base, model_id: 'synthetic' },
  }]]);
  const { application, page } = await launch(dataDir);
  try {
    await nav(page, 'Settings').click();
    await settingsSection(page, 'Model').click();
    await page.getByLabel('API key').fill('synthetic-ui-key');
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByRole('button', { name: 'Replace key' })).toBeVisible();
    await nav(page, 'Jobs').click();
    await row(page, title(0)).getByRole('checkbox').check();
    await row(page, title(1)).getByRole('checkbox').check();
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score selected (2)' }).click();
    await expect.poll(() => model.calls.length).toBe(1);
    await row(page, title(1)).click();
    const drawer = page.getByRole('complementary', { name: 'Job details' });
    await expect(drawer.getByRole('button', { name: 'Rescore' })).toBeDisabled();
    await nav(page, 'Runs').click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stopping…' })).toBeVisible();
    model.release();
    await expect(page.getByRole('region', { name: 'Run details' }).locator('.run-status')).toHaveText('Stopped');
    const pending = (await page.evaluate(id => window.jobVaccum.getJobDetail({ job_id: id }), fixture(1).id)).result;
    expect(pending.score_state).toBe('pending');

    await nav(page, 'Jobs').click();
    await row(page, title(1)).click();
    await expect(drawer.getByRole('button', { name: 'Rescore' })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Rescore' }).click();
    await expect(drawer.locator('.score-large')).toHaveText('7', { timeout: 20_000 });
    expect(model.calls.filter(call => call.text.includes(title(1)))).toHaveLength(1);
    expect(page.errors).toEqual([]);
  } finally {
    model.release();
    await quit(application);
    await model.close();
  }
});

test('Settings › Model: protocol help, unsaved test, errors, key storage and save', async () => {
  test.skip(!!packaged, 'M3 installed package has not been built.');
  test.setTimeout(90_000);
  const model = await modelServer();
  const dataDir = await directory();
  await seed(dataDir, [['dev.import_synthetic', { count: 3 }], ['settings.save', { retention_days: 0, auto_score_enabled: false }]]);
  let application;
  try {
    let page;
    ({ application, page } = await launch(dataDir));
    // Without a model, Score is unavailable and says why.
    await expect(scoreButton(page)).toBeDisabled();
    await expect(scoreButton(page)).toHaveAttribute('title', /model connection/);

    await nav(page, 'Settings').click();
    await settingsSection(page, 'Model').click();
    const form = page.locator('.settings-content');
    await expect(form.getByRole('heading', { name: 'Model connection' })).toBeVisible();
    await expect(form.getByText(/title, company and description/)).toBeVisible();
    const protocol = form.getByLabel('Protocol');
    const baseUrl = form.getByLabel('Base URL');
    const modelId = form.getByLabel('Model ID');
    const testButton = form.getByRole('button', { name: 'Test connection' });
    await expect(testButton).toBeDisabled();
    await expect(testButton).toHaveAttribute('title', 'Save an API key first.');

    // Help and the endpoint preview follow the protocol; nothing is adapted to a provider.
    await protocol.selectOption('anthropic_messages');
    await baseUrl.fill(`${model.base}/`);
    await modelId.fill('synthetic');
    await expect(form.locator('.endpoint-preview')).toHaveText(`Requests go to ${model.base}/messages`);
    await expect(form.getByLabel('API version')).toHaveValue('2023-06-01');
    await expect(form.getByLabel('Thinking')).toBeVisible();
    await form.getByLabel('Thinking').fill('[1]');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.getByText('Anthropic Messages requires a maximum. Enter one, such as 1024.')).toBeVisible();
    await expect(form.getByText('Enter a JSON object, like the example.')).toBeVisible();
    await protocol.selectOption('gemini_generate_content');
    await expect(form.locator('.endpoint-preview')).toHaveText(`Requests go to ${model.base}/models/synthetic:generateContent`);
    await expect(form.getByLabel('API version')).toHaveCount(0);
    await protocol.selectOption('chat_completions');
    await expect(form.getByLabel('Reasoning effort')).toHaveValue('');
    await expect(form.locator('.endpoint-preview')).toHaveText(`Requests go to ${model.base}/chat/completions`);
    await baseUrl.fill('ftp://example.test/v1');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.getByText(/Enter an http or https address/)).toBeVisible();
    await baseUrl.fill(model.base);

    // The key goes to secure storage only; blank input is refused locally.
    await form.getByLabel('API key').fill('   ');
    await form.getByRole('button', { name: 'Save key' }).click();
    await expect(form.getByText('Paste the API key.')).toBeVisible();
    await form.getByLabel('API key').fill('  synthetic-ui-key\t');
    await form.getByRole('button', { name: 'Save key' }).click();
    await expect(toast(page).filter({ hasText: 'API key saved' })).toBeVisible();
    await expect(form.getByLabel('API key')).toHaveValue('');
    await expect(form.getByLabel('API key')).toHaveAttribute('placeholder', /Saved/);
    await expect(form.getByRole('button', { name: 'Replace key' })).toBeVisible();

    // Unsaved fields are tested as entered: 0 is sent, blanks are left out.
    await form.getByLabel('Temperature').fill('0');
    await testButton.click();
    await expect(form.getByText('Connected. The model replied.')).toBeVisible({ timeout: 20_000 });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].path).toBe('/custom/v1/chat/completions');
    expect(model.calls[0].headers.authorization).toBe('Bearer synthetic-ui-key');
    expect(model.calls[0].body.temperature).toBe(0);
    expect(model.calls[0].body).not.toHaveProperty('max_completion_tokens');
    expect(model.calls[0].body).not.toHaveProperty('reasoning_effort');
    expect((await page.evaluate(() => window.jobVaccum.getSettings())).result.model).toBeNull();

    // A failed test explains what to check and keeps every field.
    await modelId.fill('denied-model');
    await testButton.click();
    await expect(form.getByRole('alert').filter({ hasText: "Couldn't connect" })).toContainText('Check the API key');
    await expect(form.getByRole('alert').filter({ hasText: "Couldn't connect" })).toContainText('HTTP 401');
    await expect(modelId).toHaveValue('denied-model');
    await expect(form.getByLabel('Temperature')).toHaveValue('0');
    await modelId.fill('synthetic');

    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page).filter({ hasText: 'Model connection saved' })).toBeVisible();
    const saved = (await page.evaluate(() => window.jobVaccum.getSettings())).result;
    expect(saved.model).toEqual({
      protocol: 'chat_completions', base_url: model.base, model_id: 'synthetic', temperature: 0,
      max_output_tokens: null, reasoning_effort: null, thinking: null, anthropic_version: null,
    });
    expect(saved.has_key).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('synthetic-ui-key');
    await expect(form.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);

    // Removing the key turns tests off again.
    await form.getByRole('button', { name: 'Remove key' }).click();
    await expect(toast(page).filter({ hasText: 'API key removed' })).toBeVisible();
    await expect(testButton).toBeDisabled();
    await form.getByLabel('API key').fill('synthetic-ui-key');
    await form.getByRole('button', { name: 'Save key' }).click();
    await expect(form.getByRole('button', { name: 'Replace key' })).toBeVisible();
    expect(page.errors).toEqual([]);
    await quit(application);
    application = null;

    // A key that secure storage can't read is reported; the file is kept and scoring says why.
    await writeFile(path.join(dataDir, 'model-key.enc'), Buffer.from('synthetic-unreadable'));
    ({ application, page } = await launch(dataDir));
    await expect(scoreButton(page)).toHaveAttribute('title', /can't be read/);
    await nav(page, 'Settings').click();
    await settingsSection(page, 'Model').click();
    await expect(page.locator('.key-error').getByRole('alert')).toContainText('AUTH_ERROR');
    await expect(page.getByLabel('Model ID')).toHaveValue('synthetic');
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove key' })).toBeVisible();
    expect(page.errors).toEqual([]);
  } finally {
    if (application) await quit(application);
    await model.close();
  }
});

test('Filters & scoring: rubric is saved as written and asks before turning on auto-scoring', async () => {
  test.skip(!!packaged, 'M3 installed package has not been built.');
  const dataDir = await directory();
  await seed(dataDir, [['settings.save', { retention_days: 0, auto_score_enabled: false }]]);
  const { application, page } = await launch(dataDir);
  try {
    await nav(page, 'Settings').click();
    await settingsSection(page, 'Filters & scoring').click();
    const autoScore = page.getByRole('checkbox', { name: /Score new jobs during each run/ });
    await expect(autoScore).toBeDisabled();
    const rubric = page.getByRole('textbox', { name: 'Scoring rubric' });
    await expect(rubric).toHaveValue('');
    const text = '# Synthetic rubric\n- Prefer synthetic roles.\n';
    await rubric.fill(text);
    await page.getByRole('button', { name: 'Save rubric' }).click();
    await expect(toast(page).filter({ hasText: 'Rubric saved' })).toBeVisible();
    // Saving the rubric asks; it never turns auto-scoring on by itself.
    const ask = page.locator('.ask-box');
    await expect(ask).toContainText('Automatic scoring is off');
    let settings = (await page.evaluate(() => window.jobVaccum.getSettings())).result;
    expect(settings.rubric).toBe(text);
    expect(settings.auto_score_enabled).toBe(false);
    await ask.getByRole('button', { name: 'Turn on' }).click();
    await expect(autoScore).toBeChecked();
    await expect(ask).toHaveCount(0);
    settings = (await page.evaluate(() => window.jobVaccum.getSettings())).result;
    expect(settings.auto_score_enabled).toBe(true);
    // No model yet: the switch says runs can't start until one is saved.
    await expect(page.locator('#auto-score-help')).toContainText('Needs a model connection');

    // While auto-scoring is on the rubric can't be emptied.
    await rubric.fill('');
    await page.getByRole('button', { name: 'Save rubric' }).click();
    await expect(page.getByText('Automatic scoring needs a rubric.', { exact: false })).toBeVisible();
    expect((await page.evaluate(() => window.jobVaccum.getSettings())).result.rubric).toBe(text);
    await page.getByRole('button', { name: 'Discard changes' }).first().click();
    await expect(rubric).toHaveValue(text);
    expect(page.errors).toEqual([]);
  } finally {
    await quit(application);
  }
});

test('Score menu, details Score and scoring runs: selected, all matching, failure keeps the old score', async () => {
  test.skip(!!packaged, 'M3 installed package has not been built.');
  test.setTimeout(120_000);
  // Fixture 2 has an earlier score of 2; its rescore fails. Fixture 3 scores 7.
  const model = await modelServer({ fail: [title(2)] });
  const dataDir = await directory();
  await seed(dataDir, [['dev.import_synthetic', { count: 30 }], ['settings.save', {
    retention_days: 0, auto_score_enabled: false, rubric: 'Synthetic rubric.',
    model: { protocol: 'chat_completions', base_url: model.base, model_id: 'synthetic' },
  }]]);
  const { application, page } = await launch(dataDir);
  try {
    await expect(scoreButton(page)).toHaveAttribute('title', /API key/);
    await nav(page, 'Settings').click();
    await settingsSection(page, 'Model').click();
    await page.getByLabel('API key').fill('synthetic-ui-key');
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByRole('button', { name: 'Replace key' })).toBeVisible();
    await nav(page, 'Jobs').click();
    await expect(scoreButton(page)).toBeEnabled();

    // Score all N matching… confirms the full filtered count before sending anything.
    await scoreButton(page).click();
    await expect(page.getByRole('menuitem', { name: 'Score selected (0)' })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('menuitem', { name: 'Score all 30 matching…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Score 30 jobs?' });
    await expect(dialog).toContainText('synthetic');
    await expect(dialog).toContainText('127.0.0.1');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(model.calls).toHaveLength(0);

    // Score selected: one success, one failure that keeps its earlier score.
    await row(page, title(2)).getByRole('checkbox').check();
    await row(page, title(3)).getByRole('checkbox').check();
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score selected (2)' }).click();
    const started = toast(page).filter({ hasText: 'Scoring 2 jobs' });
    await expect(started).toBeVisible();
    await expect(view(page).locator('.selected-count')).toHaveCount(0);
    // While the scoring run is active Score is unavailable everywhere.
    await expect(scoreButton(page)).toBeDisabled();
    await expect(scoreButton(page)).toHaveAttribute('title', /run is in progress/);
    await started.getByRole('button', { name: 'View progress' }).click();
    const detail = page.getByRole('region', { name: 'Run details' });
    await expect(detail).toContainText('Manual scoring');
    await expect(detail.locator('.run-status')).toHaveText(/Partly completed/, { timeout: 30_000 });
    await expect(detail).toContainText('2 of 2 tasks done');
    await expect(page.getByRole('navigation', { name: 'Run history' }).locator('.run-item').first()).toContainText('Scoring · 2 jobs');
    expect(model.calls.filter(call => call.text.includes(title(2)))).toHaveLength(1);
    const score2 = (await page.evaluate(id => window.jobVaccum.getJobDetail({ job_id: id }), fixture(2).id)).result;
    expect(score2.score).toBe(2);
    expect(score2.score_state).toBe('failed');
    const score3 = (await page.evaluate(id => window.jobVaccum.getJobDetail({ job_id: id }), fixture(3).id)).result;
    expect(score3.score).toBe(7);
    expect(score3.score_reason).toBe('Synthetic seven.');

    // "1 failed" opens Jobs filtered to failed scoring; the old score stays with "!".
    await detail.getByRole('button', { name: '1 failed' }).click();
    await expect(view(page).locator('.chip-label')).toHaveText(['Score: Failed']);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator('.score')).toHaveText('!');
    await rows(page).first().click();
    const drawer = page.getByRole('complementary', { name: 'Job details' });
    await expect(drawer).toContainText('Scoring failed. The score shown is from');
    await expect(drawer).toContainText('HTTP 400');
    await view(page).locator('.chip-remove').click();

    // Score all matching on a narrowed filter, then rescore from the details.
    await page.getByRole('searchbox', { name: 'Search jobs' }).fill(title(5));
    await expect(rows(page)).toHaveCount(1);
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score all 1 matching…' }).click();
    await page.getByRole('dialog', { name: 'Score 1 job?' }).getByRole('button', { name: 'Score 1 job' }).click();
    await expect(toast(page).filter({ hasText: 'Scoring 1 job' })).toBeVisible();
    await rows(page).first().click();
    await expect(drawer.getByRole('button', { name: 'Rescore' })).toBeDisabled();
    // The open details follow the result without a manual refresh.
    await expect(drawer.locator('.score-large')).toHaveText('7', { timeout: 30_000 });
    await expect(drawer).toContainText('Synthetic seven.');
    await expect(drawer.getByRole('button', { name: 'Rescore' })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Rescore' }).click();
    await expect.poll(() => model.calls.filter(call => call.text.includes(title(5))).length, { timeout: 30_000 }).toBe(2);
    await expect(drawer.getByRole('button', { name: 'Rescore' })).toBeEnabled({ timeout: 15_000 });

    // Shortlist has the same menu.
    await nav(page, 'Shortlist').click();
    await expect(scoreButton(page)).toBeEnabled();
    await scoreButton(page).click();
    await expect(page.getByRole('menuitem', { name: 'Score all 0 matching…' })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    await nav(page, 'Runs').click();
    await expect(page.getByRole('navigation', { name: 'Run history' }).locator('.run-item')).toHaveCount(3);
    expect(model.calls.every(call => call.headers.authorization === 'Bearer synthetic-ui-key')).toBe(true);
    expect(page.errors).toEqual([]);
  } finally {
    await quit(application);
    await model.close();
  }
});
