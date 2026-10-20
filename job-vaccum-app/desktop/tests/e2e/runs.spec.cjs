// M2 renderer: Runs, batch filter and manual configuration. Run history is
// written as synthetic rows before launch; no test here starts a real run, so
// nothing reaches LinkedIn or Indeed. Start/Stop is driven at the IPC boundary.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { jobId, directory, seed, launch, quit, resize, nav, view, rows, toast, noPageOverflow } = require('./support.cjs');

const SOFTWARE = '00000000-0000-0000-0000-000000000001';
const DATA = '00000000-0000-0000-0000-000000000002';
const chips = page => view(page).locator('.chip-label');
const runItems = page => page.getByRole('navigation', { name: 'Run history' }).locator('.run-item');
const detail = page => page.getByRole('region', { name: 'Run details' });
const label = ms => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const sql = value => `'${JSON.stringify(value).replaceAll("'", "''")}'`;
const counts = (total, succeeded, failed) => ({ total, succeeded, failed, active: 0, pending: 0, cancelled: 0 });
const none = counts(0, 0, 0);
const validConfig = ['settings.save', { auto_score_enabled: false, platforms: ['indeed'], cities: [{ location: 'Austin, TX', distance_miles: 25, enabled: true }] }];

/** Two finished runs: A (older, 5 new) and B (newer, partly completed, 3 new). */
function runHistory(now) {
  const a = { id: 'run-a', started: now - 26 * 3600e3 };
  const b = { id: 'run-b', started: now - 2 * 3600e3 };
  const spec = (direction, query, site) => ({ query_id: query, direction_id: direction, expression: `Synthetic ${direction === SOFTWARE ? 'Software' : 'Data'} Engineer`,
    city_id: 'city-1', location: 'Austin, TX', distance_miles: 25, site, country_indeed: 'usa' });
  const runRow = (run, status, stats, finished) => `INSERT INTO runs VALUES ('${run.id}','pipeline','${status}',${run.started},${run.started},${finished},${sql({ auto_score_enabled: false })},${sql(stats)},NULL);`;
  const task = (run, id, order, status, attempts, taskSpec, stats, error) =>
    `INSERT INTO run_tasks VALUES ('${id}','${run.id}','retrieval',${order},${sql(taskSpec)},'${status}',${attempts},${sql(stats)},${error ? sql(error) : 'NULL'});`;
  const job = (run, i, isNew) => `INSERT INTO run_jobs VALUES ('${run.id}','${jobId(i)}',${isNew ? 1 : 0});`;
  return [
    runRow(a, 'succeeded', { retrieval: counts(1, 1, 0), scoring: none, received_count: 6, filtered_count: 0, matched_job_count: 6, new_job_count: 5,
      directions: [{ direction_id: SOFTWARE, received_count: 6, filtered_count: 0, matched_job_count: 6 }] }, a.started + 5 * 60e3),
    task(a, 'task-a1', 0, 'succeeded', 1, spec(SOFTWARE, 'q-1', 'indeed'), { received_count: 6, filtered_count: 0, matched_job_count: 6 }),
    ...[1, 2, 3, 4, 5].map(i => job(a, i, true)), job(a, 6, false),
    runRow(b, 'partial', { retrieval: counts(3, 2, 1), scoring: none, received_count: 14, filtered_count: 3, matched_job_count: 4, new_job_count: 3,
      directions: [{ direction_id: SOFTWARE, received_count: 10, filtered_count: 2, matched_job_count: 3 },
        { direction_id: DATA, received_count: 4, filtered_count: 1, matched_job_count: 2 }] }, b.started + 12 * 60e3),
    task(b, 'task-b1', 0, 'succeeded', 1, spec(SOFTWARE, 'q-1', 'indeed'),
      { received_count: 10, filtered_count: 2, filter_reasons: { senior_title: 2 }, matched_job_count: 3, missing_jd_count: 1 }),
    task(b, 'task-b2', 1, 'failed', 3, spec(SOFTWARE, 'q-1', 'linkedin'),
      { received_count: 4, filtered_count: 1, filter_reasons: { company: 1 }, matched_job_count: 2, http_429: 2 },
      { code: 'NETWORK_ERROR', message: 'LinkedIn did not respond.', retryable: false }),
    task(b, 'task-b3', 2, 'succeeded', 1, spec(DATA, 'q-2', 'indeed'), { received_count: 0, filtered_count: 0, matched_job_count: 0 }),
    ...[7, 8, 9].map(i => job(b, i, true)), job(b, 1, false),
  ].join('\n');
}

test('Runs: history, progress, per-search stats, batch filter and cleaned-up batches', { tag: '@smoke' }, async () => {
  const dataDir = await directory();
  const now = Date.now();
  await seed(dataDir, [['dev.import_synthetic', { count: 20 }], validConfig], runHistory(now));
  let { application, page } = await launch(dataDir);
  try {
    const labelA = label(now - 26 * 3600e3);
    const labelB = label(now - 2 * 3600e3);
    await expect(page.locator('.sidebar-run')).toHaveText(`Last run ${labelB} · Partly completed`);
    await nav(page, 'Runs').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Runs');
    await expect(page.locator('.page-subtitle')).toHaveText('2 runs');
    await expect(page.locator('.run-plan')).toContainText('Next run: 2 tasks');
    await expect(page.locator('.run-plan')).toContainText('Auto-scoring off');
    await expect(page.getByRole('button', { name: 'Run now' })).toBeEnabled();
    await expect(runItems(page)).toHaveCount(2);
    await expect(runItems(page).nth(0)).toContainText(labelB);
    await expect(runItems(page).nth(0)).toContainText('Partly completed');
    await expect(runItems(page).nth(0)).toContainText('3 new');
    await expect(runItems(page).nth(1)).toContainText('Completed');

    // Newest run is shown: failures and zero results are told apart.
    await expect(detail(page).locator('.run-status')).toHaveText('Partly completed');
    await expect(detail(page)).toContainText('took 12 minutes');
    await expect(detail(page).locator('.progress-row').first()).toContainText('3 of 3 tasks done · 1 failed');
    await expect(detail(page)).toContainText('Auto-scoring was off for this run');
    const totals = detail(page).locator(':scope > .run-totals');
    await expect(totals).toContainText('Received14');
    await expect(totals).toContainText('Filtered out3');
    await expect(totals).toContainText('Matched jobs4');
    await expect(detail(page).getByRole('region', { name: 'Filtered by rule' })).toContainText('Senior title2');
    await expect(detail(page).getByRole('region', { name: 'Filtered by rule' })).toContainText('Excluded company1');
    const bySearch = detail(page).getByRole('table', { name: 'By search' });
    await expect(bySearch.locator('tbody tr')).toHaveText([/^Software\s*1023$/, /^Data\s*412$/]);
    const tasks = detail(page).getByRole('table', { name: 'Tasks' }).locator('tbody tr');
    await expect(tasks).toHaveCount(3);
    await expect(tasks.nth(0)).toContainText('1 without description');
    await expect(tasks.nth(1)).toContainText('Failed');
    await expect(tasks.nth(1)).toContainText('LinkedIn did not respond.');
    await expect(tasks.nth(1)).toContainText('Rate limited 2×');
    await expect(tasks.nth(2)).toContainText('No results');
    await expect(tasks.nth(0).locator('td').nth(6)).toHaveAttribute('title', 'Senior title: 2');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await resize(application, 640, 480);
    expect(await noPageOverflow(page)).toBe(true);
    await page.screenshot({ path: path.join(dataDir, 'rule-counts-narrow.png') });
    await resize(application, 1280, 800);

    await runItems(page).nth(1).click();
    await expect(detail(page).locator('.run-status')).toHaveText('Completed');
    await expect(bySearch.locator('tbody tr')).toHaveText([/^Software\s*606$/]);
    await page.screenshot({ path: path.join(dataDir, 'runs.png') });

    // "N new" opens Jobs filtered to that batch.
    await runItems(page).nth(0).click();
    await detail(page).getByRole('button', { name: '3 new' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jobs');
    await expect(chips(page)).toHaveText([`Batch: ${labelB}`]);
    await expect(rows(page)).toHaveCount(3);

    // Batch editor: All plus each run with its new count; several runs combine.
    await view(page).locator('.chip-label').click();
    const editor = page.getByRole('dialog', { name: 'Batch filter' });
    await expect(editor.getByRole('checkbox', { name: 'All batches' })).not.toBeChecked();
    await editor.getByRole('checkbox', { name: `${labelA} · 5 new` }).check();
    await editor.getByRole('button', { name: 'Apply' }).click();
    await expect(chips(page)).toHaveText([`Batch: ${labelB}, ${labelA}`]);
    await expect(rows(page)).toHaveCount(8);
    // The batch filter is a Jobs filter only.
    await nav(page, 'Shortlist').click();
    await view(page).getByRole('button', { name: '+ Filter' }).click();
    await expect(page.getByRole('menuitem', { name: 'Batch' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await quit(application);

    // Restart keeps the batch; clearing job data removes the runs and the stale batch filter.
    ({ application, page } = await launch(dataDir));
    await expect(chips(page)).toHaveText([`Batch: ${labelB}, ${labelA}`]);
    await expect(rows(page)).toHaveCount(8);
    await nav(page, 'Settings').click();
    await page.locator('.settings-nav').getByRole('button', { name: 'Data' }).click();
    await page.getByRole('button', { name: 'Clear job data…' }).click();
    const clear = page.getByRole('dialog', { name: 'Clear job data?' });
    await expect(clear).toContainText('2 runs from Runs');
    await clear.getByRole('button', { name: 'Clear job data' }).click();
    await expect(toast(page).filter({ hasText: 'Cleared 20 jobs and 2 runs' })).toBeVisible();
    await expect(toast(page).filter({ hasText: 'A batch filter for a run that no longer exists was removed.' })).toBeVisible();
    await nav(page, 'Jobs').click();
    await expect(chips(page)).toHaveCount(0);
    await nav(page, 'Runs').click();
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    await expect(page.locator('.sidebar-run')).toHaveCount(0);
    expect(page.errors).toEqual([]);
  } finally { await application.close(); }
});

test('Runs: Run now and Stop follow run events; repeat clicks are blocked', async () => {
  const dataDir = await directory();
  await seed(dataDir, [['dev.import_synthetic', { count: 5 }], validConfig]);
  const { application, page } = await launch(dataDir);
  try {
    // Only the run commands are replaced; preview and settings stay on the real backend.
    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      const now = Date.now();
      const zero = { total: 0, succeeded: 0, failed: 0, active: 0, pending: 0, cancelled: 0 };
      globalThis.fake = { run: null, starts: 0 };
      const summary = () => ({ ...globalThis.fake.run, kind: 'pipeline', created_at: now, started_at: now, new_job_count: 0, error: null,
        stats: { retrieval: { ...zero, total: 2, ...globalThis.fake.counts }, scoring: zero, received_count: 0, filtered_count: 0,
          matched_job_count: 0, new_job_count: 0, directions: [] } });
      globalThis.emit = (status, stage, finished) => {
        globalThis.fake.run = { id: 'fake-run', status, stage, finished_at: finished ? Date.now() : null };
        BrowserWindow.getAllWindows()[0].webContents.send('app:service-event',
          { type: 'event', name: 'run.updated', seq: 1000, data: { run_id: 'fake-run', status, stage } });
      };
      for (const channel of ['runs:start', 'runs:stop', 'runs:list', 'runs:detail', 'app:status']) ipcMain.removeHandler(channel);
      ipcMain.handle('runs:start', () => new Promise(resolve => {
        globalThis.fake.starts += 1;
        setTimeout(() => {
          globalThis.fake.counts = { active: 1, pending: 1 };
          globalThis.fake.run = { id: 'fake-run', status: 'running', stage: 'retrieving', finished_at: null };
          resolve({ ok: true, result: { run_id: 'fake-run' } });
        }, 600);
      }));
      ipcMain.handle('runs:stop', () => {
        globalThis.fake.stopped = true;
        return { ok: true, result: { run_id: 'fake-run' } };
      });
      ipcMain.handle('runs:list', (_event, params) => ({ ok: true,
        result: globalThis.fake.run && params?.kind !== 'rescore' ? { items: [summary()], total: 1 } : { items: [], total: 0 } }));
      ipcMain.handle('runs:detail', () => ({ ok: true, result: { ...summary(), config_snapshot: { auto_score_enabled: false }, tasks: [], task_total: 2, jobs: [] } }));
      ipcMain.handle('app:status', () => ({ ok: true, result: { active_run: globalThis.fake.run && ['running', 'stopping'].includes(globalThis.fake.run.status)
        ? { run_id: 'fake-run', status: globalThis.fake.run.status, stage: globalThis.fake.run.stage } : null,
      operations: [], cleanup: { status: 'idle' }, configuration_complete: true, storage: { schema_version: 3, journal_mode: 'wal' } } }));
    });
    await nav(page, 'Runs').click();
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    const runNow = page.getByRole('button', { name: /^Run now|^Starting/ });
    await expect(runNow).toBeEnabled();
    await runNow.click();
    await expect(runNow).toHaveText('Starting…');
    await expect(runNow).toBeDisabled();
    await runNow.click({ force: true });
    await expect(detail(page).locator('.run-status')).toHaveText('Running · Searching');
    expect(await application.evaluate(() => globalThis.fake.starts)).toBe(1);
    await expect(runNow).toBeDisabled();
    await expect(page.locator('.sidebar-run')).toHaveText('Run in progress · Searching');
    await expect(detail(page).locator('.progress-row').first()).toContainText('0 of 2 tasks done · 1 running · 1 waiting');

    await page.getByRole('button', { name: 'Stop' }).click();
    expect(await application.evaluate(() => globalThis.fake.stopped)).toBe(true);
    await application.evaluate(() => globalThis.emit('stopping', 'retrieving'));
    await expect(page.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    await expect(page.locator('.sidebar-run')).toHaveText('Stopping run…');
    await application.evaluate(() => {
      globalThis.fake.counts = { succeeded: 1, cancelled: 1 };
      globalThis.emit('stopped', null, true);
    });
    await expect(detail(page).locator('.run-status')).toHaveText('Stopped');
    await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
    await expect(runNow).toBeEnabled();
    await expect(detail(page).locator('.progress-row').first()).toContainText('2 of 2 tasks done · 1 cancelled');
    expect(page.errors).toEqual([]);
  } finally { await application.close(); }
});

test('Settings: searches, queries, locations, scoring switch, filter rules and proxy', async () => {
  const dataDir = await directory();
  await seed(dataDir, [['settings.save', { cities: [] }]]);
  let { application, page } = await launch(dataDir);
  const settings = () => page.evaluate(() => window.jobVaccum.getSettings().then(response => response.result));
  try {
    // A new install can't run: no searches, and auto-scoring is on without a rubric.
    await nav(page, 'Runs').click();
    await expect(page.locator('.run-plan')).toContainText("Can't run yet.");
    await expect(page.getByRole('button', { name: 'Run now' })).toBeDisabled();
    await page.locator('.run-plan').getByRole('button').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');

    // Searches: add one, then its queries (empty refused, edit, off, delete).
    await expect(page.getByRole('heading', { name: 'No searches yet' })).toBeVisible();
    await page.getByRole('button', { name: 'Add search' }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a name.' })).toBeVisible();
    await page.getByRole('textbox', { name: 'New search name' }).fill('Data engineering');
    await page.keyboard.press('Enter');
    await expect(page.locator('.searches .search-item')).toHaveText([/^All searches/, /^Data engineering/]);
    const queryInput = page.getByRole('textbox', { name: 'Add a query to Data engineering' });
    await queryInput.fill('   ');
    await page.getByRole('button', { name: 'Add query' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a query.' })).toBeVisible();
    await queryInput.fill('data engineer');
    await page.keyboard.press('Enter');
    await queryInput.fill('analytics engineer');
    await page.keyboard.press('Enter');
    const queries = page.getByRole('list', { name: 'Queries for Data engineering' }).locator('.query-row');
    await expect(queries).toHaveText([/^analytics engineer/, /^data engineer/]);
    await queries.filter({ hasText: 'analytics engineer' }).getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Query', exact: true }).fill('analytics engineer remote');
    await page.keyboard.press('Enter');
    await expect(queries).toHaveText([/^analytics engineer remote/, /^data engineer/]);
    await page.getByRole('checkbox', { name: 'Use query analytics engineer remote' }).uncheck();
    await page.getByRole('button', { name: 'Delete query data engineer' }).click();
    await expect(toast(page).filter({ hasText: 'Deleted query “data engineer”' })).toBeVisible();
    await expect(queries).toHaveCount(1);
    await page.getByRole('checkbox', { name: 'Use query analytics engineer remote' }).check();
    let saved = await settings();
    expect(saved.directions).toMatchObject([{ name: 'Data engineering', enabled: true, queries: [{ expression: 'analytics engineer remote', enabled: true }] }]);

    // Locations and sites: a draft until Save; invalid radius and empty country are explained.
    await page.getByRole('textbox', { name: 'Add a location' }).fill('Austin, TX');
    await page.getByRole('button', { name: 'Add location' }).click();
    await page.getByRole('textbox', { name: 'Radius for Austin, TX in miles' }).fill('far');
    await page.getByLabel('Indeed country').fill('');
    await page.getByRole('checkbox', { name: 'LinkedIn' }).uncheck();
    const saveLocations = page.getByRole('region', { name: 'Locations and sites' }).getByRole('button', { name: 'Save' });
    await saveLocations.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Radius is a whole number of miles from 0 to 1000.' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter the Indeed country.' })).toBeVisible();
    expect((await settings()).cities).toEqual([]);
    await page.getByRole('textbox', { name: 'Radius for Austin, TX in miles' }).fill('25');
    await page.getByLabel('Indeed country').fill('usa');
    await saveLocations.click();
    await expect(toast(page).filter({ hasText: 'Locations and sites saved' })).toBeVisible();
    await expect(saveLocations).toBeDisabled();
    saved = await settings();
    expect(saved.cities).toMatchObject([{ location: 'Austin, TX', distance_miles: 25, enabled: true }]);
    expect(saved.platforms).toEqual(['indeed']);
    expect(saved.country_indeed).toBe('usa');

    // Still blocked by auto-scoring without a rubric; turning it off allows a run.
    await nav(page, 'Runs').click();
    await expect(page.locator('.run-plan')).toContainText('automatic scoring');
    await page.locator('.run-plan').getByRole('button', { name: 'Filters & scoring' }).click();
    const scoring = page.getByRole('checkbox', { name: /^Score new jobs during each run/ });
    await expect(scoring).toBeChecked();
    await scoring.uncheck();
    await expect(toast(page).filter({ hasText: 'Automatic scoring is off for new runs' })).toBeVisible();
    // Without a rubric it can't be turned back on.
    await expect(scoring).toBeDisabled();
    await expect(page.getByText('Needs a scoring rubric. Until then, new jobs stay unscored.')).toBeVisible();
    await nav(page, 'Runs').click();
    await expect(page.locator('.run-plan')).toContainText('Next run: 1 task');
    await expect(page.getByRole('button', { name: 'Run now' })).toBeEnabled();

    // Filter rules: invalid years are explained; saved rules match the form.
    await nav(page, 'Settings').click();
    await page.locator('.settings-nav').getByRole('button', { name: 'Filters & scoring' }).click();
    await page.getByRole('checkbox', { name: 'More experience required than' }).check();
    await page.getByRole('textbox', { name: 'Most years of required experience' }).fill('x');
    await page.getByLabel('Excluded companies').fill('Acme\n  Acme \nGlobex\n');
    await page.getByRole('checkbox', { name: 'Work authorization conflicts' }).check();
    await page.getByRole('checkbox', { name: /I need visa sponsorship/ }).check();
    await page.getByRole('combobox', { name: 'My work authorization' }).selectOption('opt');
    await page.getByRole('textbox', { name: 'My degrees' }).fill('Bachelor, Master');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter whole years from 0 to 100.' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Most years of required experience' }).fill('5');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page).filter({ hasText: 'Filter rules saved' })).toBeVisible();
    expect((await settings()).rules).toEqual({
      enabled_rule_ids: ['experience', 'authorization'], experience_max_years: 5, excluded_companies: ['Acme', 'Globex'],
      qualifications: { requires_sponsorship: true, work_authorization: 'opt', degrees: ['Bachelor', 'Master'] },
    });

    // Proxy: sign-in details are refused in the address; a plain origin is saved.
    await page.locator('.settings-nav').getByRole('button', { name: 'Proxy' }).click();
    await page.getByRole('radio', { name: /^Proxy for LinkedIn and Indeed/ }).check();
    await page.getByRole('textbox', { name: 'Address' }).fill('http://user:secret@127.0.0.1:8080');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'without a username or path' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Address' }).fill('http://127.0.0.1:8080');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page).filter({ hasText: 'Runs use the proxy' })).toBeVisible();
    expect((await settings()).proxy).toEqual({ mode: 'ordinary', url: 'http://127.0.0.1:8080' });
    await expect(page.getByRole('button', { name: 'Save sign-in' })).toBeVisible();
    await page.getByRole('button', { name: 'Save sign-in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a username and password.' })).toBeVisible();
    // The Mac's secure storage is replaced in main so the test never touches Keychain.
    await application.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = text => Buffer.from(`test:${text}`);
      safeStorage.decryptString = buffer => buffer.toString().slice(5);
    });
    await page.getByRole('textbox', { name: 'Username' }).fill('synthetic user');
    await page.getByLabel('Password').fill('p@ss:word');
    await page.getByRole('button', { name: 'Save sign-in' }).click();
    await expect(toast(page).filter({ hasText: 'Proxy sign-in saved' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace sign-in' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue('');
    saved = await settings();
    expect(saved.has_proxy_credentials).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('p@ss');
    expect(await page.evaluate(() => window.jobVaccum.previewRun().then(response => response.ok))).toBe(true);
    await page.getByRole('button', { name: 'Remove saved sign-in' }).click();
    await expect(toast(page).filter({ hasText: 'Proxy sign-in removed' })).toBeVisible();
    expect((await settings()).has_proxy_credentials).toBe(false);
    await page.getByRole('radio', { name: /^Direct connection/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page).filter({ hasText: 'Runs connect directly' })).toBeVisible();
    expect((await settings()).proxy).toEqual({ mode: 'off', url: 'http://127.0.0.1:8080' });
    await quit(application);

    // Everything above is stored settings, not local preferences.
    ({ application, page } = await launch(dataDir));
    await nav(page, 'Settings').click();
    await expect(page.getByRole('textbox', { name: 'Radius for Austin, TX in miles' })).toHaveValue('25');
    await page.locator('.settings-nav').getByRole('button', { name: 'Filters & scoring' }).click();
    await expect(page.getByRole('textbox', { name: 'Most years of required experience' })).toHaveValue('5');
    await expect(page.getByLabel('Excluded companies')).toHaveValue('Acme\nGlobex');

    // Narrow window: Runs and Settings fit without page overflow.
    await resize(application, 640, 480);
    expect(await noPageOverflow(page)).toBe(true);
    await nav(page, 'Runs').click();
    await expect(page.locator('.run-plan')).toContainText('Next run: 1 task');
    await expect(page.getByRole('button', { name: 'Run now' })).toBeEnabled();
    expect(await noPageOverflow(page)).toBe(true);
    await page.screenshot({ path: path.join(dataDir, 'runs-narrow.png') });
    expect(page.errors).toEqual([]);
  } finally { await application.close(); }
});
