const { test, expect, _electron: electron } = require('@playwright/test');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { directory, seed, quit, jobId } = require('./support.cjs');

const root = path.resolve(__dirname, '../..');
async function launch(dir) {
  const application = await electron.launch({ executablePath: require('electron'),
    args: [path.join(root, 'tests/fixtures/mcp-main.cjs'), `--data-dir=${dir}`], cwd: '/',
    env: { ...process.env, PATH: '/usr/bin:/bin' } });
  application.ownedProcess = application.process();
  const page = await application.firstWindow();
  await expect(page.locator('.sidebar-status')).toHaveAttribute('data-connection', 'ready');
  return { application, page };
}
async function connect(dir) {
  const config = JSON.parse(await readFile(path.join(dir, 'mcp.json'), 'utf8'));
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const client = new Client({ name: 'm8-integration', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).not.toContain(config.token);
    return JSON.parse(result.content[0].text);
  };
  return { client, call, raw, config, url };
}

test('M8 all 15 tools: real protocol, Electron, Python, SQLite and fake run', async () => {
  test.setTimeout(60000);
  const dir = await directory();
  await seed(dir, [['dev.import_synthetic', { count: 405 }], ['settings.save', { retention_days: 0, auto_score_enabled: false,
    cities: [{ location: 'Chicago', distance_miles: 25, enabled: true }], platforms: ['indeed'] }]],
    `UPDATE jobs SET score_reason='${'Long complete reason. '.repeat(1000)}' WHERE id='${jobId(1)}';`);
  let { application, page } = await launch(dir);
  let connection;
  try {
    connection = await connect(dir);
    let { call, raw, client } = connection;
    const example = execFileSync(process.execPath, [path.join(root, 'scripts/mcp-client.mjs'), dir], { encoding: 'utf8', timeout: 5000 });
    expect(example).toContain('get_app_status');
    expect(example).toContain('has_more');
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual(['list_jobs', 'list_shortlist', 'get_job', 'add_to_shortlist', 'create_shortlist_job',
      'update_shortlist_job', 'set_shortlist_status', 'list_searches', 'list_schedules', 'get_schedule', 'update_schedule',
      'preview_run', 'list_runs', 'get_run', 'get_app_status'].sort());
    expect(tools.filter(t => !t.annotations.readOnlyHint)).toHaveLength(5);
    await page.evaluate(() => { window.m8Events = []; window.jobVaccum.onServiceEvent(e => window.m8Events.push(e.name)); });
    expect((await call('get_app_status')).busy).toBe(false);
    expect((await raw('create_shortlist_job', { title: 'Oversize', description: 'x'.repeat(1024*1024) })).isError).toBe(true);
    expect((await call('get_app_status')).available).toBe(true);
    const summary = await call('list_jobs');
    expect(summary.items).toHaveLength(50); expect(summary.total).toBe(405);
    expect(summary.items[1].score_reason).toBe('Long complete reason. '.repeat(1000));
    expect(Object.keys(summary.items[0]).sort()).toEqual(['id','title','company','location','job_type','score','score_reason','score_state','scored_at','first_seen_at','date_posted','in_applications'].sort());
    expect((await raw('list_jobs', { page_size: 51 })).isError).toBe(true);
    expect((await raw('list_jobs', { view: 'ids', page_size: 201 })).isError).toBe(true);
    expect((await raw('list_jobs', { scope: 'applications' })).isError).toBe(true);
    const searches = (await call('list_searches')).items;
    const filter = { direction_ids: [searches[0].id], score_min: 6, date_posted_from: '2026-10-18', date_posted_to: '2026-10-19', sort: 'score_desc' };
    const expected = (await page.evaluate(p => window.jobVaccum.listJobs(p), { ...filter, page_size: 200 })).result;
    const filtered = await call('list_jobs', { ...filter, page_size: 7 });
    const next = await call('list_jobs', { ...filter, page_size: 7, page: 2 });
    expect(filtered.total).toBe(expected.total);
    expect([...filtered.items, ...next.items].map(j => j.id)).toEqual(expected.items.slice(0, 14).map(j => j.id));
    const ids = [];
    for (let page = 1; ; page++) {
      const result = await call('list_jobs', { view: 'ids', in_applications: false, page });
      expect(result.page_size).toBe(200); expect(result.items).toBeUndefined();
      ids.push(...result.ids); if (!result.has_more) break;
    }
    expect(new Set(ids).size).toBe(405);
    expect((await raw('add_to_shortlist', { job_ids: ids.slice(0,201) })).isError).toBe(true);
    for (let i = 0; i < ids.length; i += 200) expect((await call('add_to_shortlist', { job_ids: ids.slice(i,i+200) })).counts.added).toBe(Math.min(200, ids.length-i));
    const before = await call('update_shortlist_job', { job_id: ids[0], status: 'applied', notes: 'Full notes, retained.' });
    expect((await call('add_to_shortlist', { job_ids: [ids[0], ids[0], 'missing'] })).counts).toEqual({ added: 0, already_present: 1, not_found: 1 });
    expect((await call('get_job', { job_id: ids[0] })).application).toEqual({ status: before.status, notes: before.notes, added_at: before.added_at, updated_at: before.updated_at });
    expect((await raw('update_shortlist_job', { job_id: ids[0], title: 'Cannot replace', notes: 'lost' })).isError).toBe(true);
    expect((await call('set_shortlist_status', { job_ids: [ids[0], 'missing'], status: 'interviewing' })).counts).toEqual({ updated: 1, not_found: 1 });
    const shortlisted = await call('list_shortlist', { application_statuses: ['interviewing'], updated_from: 1 });
    expect(shortlisted.total).toBe(1); expect(shortlisted.items[0].notes).toBe('Full notes, retained.');
    const detail = await call('get_job', { job_id: ids[0] });
    expect(detail.description.length).toBeGreaterThan(30000); expect(detail.sources.length).toBeGreaterThan(0);
    const manual = await call('create_shortlist_job', { title: 'Manual external role' });
    expect(manual.status).toBe('new'); expect(manual.description).toBeUndefined();
    const jd = 'Full manual JD\n'.repeat(3000);
    await call('update_shortlist_job', { job_id: manual.job_id, description: jd, company: 'Acme', job_url_direct: 'https://example.invalid/jobs/unique', status: 'applied', notes: 'Externally applied.' });
    expect((await call('get_job', { job_id: manual.job_id })).description).toBe(jd);
    expect((await call('list_jobs')).total).toBe(405);
    expect((await call('list_shortlist')).total).toBe(406);
    await expect.poll(() => page.evaluate(() => window.m8Events.includes('jobs.changed'))).toBe(true);
    const saved = await page.evaluate(() => window.jobVaccum.saveSchedule({ enabled: false, direction_ids: null, time: '09:00', weekdays: [0,1], timezone: 'UTC' }));
    const schedule_id = saved.result.id;
    expect((await call('list_schedules')).items).toHaveLength(1);
    const schedule = await call('get_schedule', { schedule_id });
    const changed = await call('update_schedule', { schedule_id, time: '10:00' });
    for (const key of ['direction_ids', 'weekdays', 'timezone', 'enabled']) expect(changed[key]).toEqual(schedule[key]);
    for (const patch of [{ time: '99:00' }, { timezone: 'No/Zone' }, { direction_ids: ['missing'] }]) expect((await raw('update_schedule', { schedule_id, ...patch })).isError).toBe(true);
    expect((await call('preview_run', { schedule_id })).task_count).toBe(2);
    expect((await call('preview_run', { direction_ids: [searches[0].id] })).task_count).toBe(1);
    expect((await raw('preview_run', { schedule_id, direction_ids: null })).isError).toBe(true);
    expect((await call('list_runs')).total).toBe(0);
    await call('update_schedule', { schedule_id, direction_ids: [searches[0].id] });
    expect((await call('preview_run', { schedule_id })).task_count).toBe(1);
    await expect.poll(() => page.evaluate(() => window.m8Events.includes('schedules.updated'))).toBe(true);
    const started = await page.evaluate(schedule_id => window.jobVaccum.startRun({ schedule_id }), schedule_id);
    expect(started.ok).toBe(true);
    const run_id = started.result.run_id;
    expect((await call('get_run', { run_id })).status).toBe('running');
    expect((await call('get_app_status')).busy).toBe(true);
    await expect.poll(async () => (await call('get_run', { run_id })).status).toBe('succeeded');
    const run = await call('get_run', { run_id });
    expect(run.stats.retrieval.succeeded).toBe(1); expect(run.stats.new_job_count).toBe(1);
    expect(run.tasks).toBeUndefined(); expect(run.error).toBeUndefined(); expect(run.config_snapshot).toBeUndefined();
    expect((await call('list_runs', { schedule_id, kind: 'pipeline', statuses: ['succeeded'], created_from: 1 })).items).toEqual([run]);
    // Use the existing IPC only to set synthetic scoring inputs/start rescore;
    // MCP intentionally has no configuration or run-start tools.
    await page.evaluate(async id => {
      await window.jobVaccum.saveSettings({ model: { protocol: 'chat_completions', base_url: 'http://localhost:9999/v1', model_id: 'fake' }, rubric: 'Synthetic rubric' });
      await window.jobVaccum.setModelKey({ key: 'synthetic-mcp-key' });
      return window.jobVaccum.scoreJobs({ job_ids: [id] });
    }, manual.job_id);
    await expect.poll(async () => (await call('list_runs', { kind: 'rescore', statuses: ['succeeded'] })).total).toBe(1);
    expect((await call('list_runs')).total).toBe(2);
    expect((await call('get_job', { job_id: manual.job_id })).score).toBe(0);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect((await call('get_app_status')).available).toBe(true);
    await call('update_shortlist_job', { job_id: manual.job_id, notes: 'Written without renderer' });
    await client.close();
    await quit(application);
    await expect(fetch(connection.url)).rejects.toThrow();
    ({ application, page } = await launch(dir));
    connection = await connect(dir); ({ call, raw } = connection);
    expect((await call('get_job', { job_id: manual.job_id })).application.notes).toBe('Written without renderer');
    expect((await page.evaluate(() => window.jobVaccum.executeCleanup({ mode: 'manual' }))).ok).toBe(true);
    expect((await call('get_job', { job_id: manual.job_id })).description).toBe(jd);
    expect((await raw('get_run', { run_id })).isError).toBe(true);
    expect((await call('list_runs')).total).toBe(0);
  } finally {
    await connection?.client.close();
    if (application.ownedProcess.exitCode === null) await quit(application);
  }
});

test('M8 authentication, Host/Origin, whitelist and backend unavailable', async () => {
  const dir = await directory();
  const { application } = await launch(dir);
  let connection;
  try {
    connection = await connect(dir);
    const { config, url, raw } = connection;
    expect((await stat(path.join(dir, 'mcp.json'))).mode & 0o777).toBe(0o600);
    const headers = { Authorization: `Bearer ${config.token}` };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer invalid' } })).status).toBe(401);
    for (const Host of ['evil.test', `127.0.0.1.evil:${config.port}`, '127.0.0.1:1']) {
      const code = await new Promise((resolve, reject) => {
        http.get(url, { headers: { ...headers, Host } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
      });
      expect(code).toBe(403);
    }
    for (const Origin of ['null', 'https://evil.test', `http://localhost:${config.port + 1}`]) expect((await fetch(url, { headers: { ...headers, Origin } })).status).toBe(403);
    expect((await fetch(url, { headers: { ...headers, Origin: `http://localhost:${config.port}` } })).status).toBe(405);
    expect((await raw('runs.start')).isError).toBe(true);
    await application.evaluate(() => global.m8Backend.child.kill('SIGKILL'));
    await expect.poll(async () => (await raw('get_app_status')).isError).toBe(true);
    const failed = await raw('list_jobs');
    expect(JSON.parse(failed.content[0].text).error.code).toBe('WORKER_EXITED');
    expect(failed.content[0].text).not.toContain(config.token);
  } finally {
    await connection?.client.close();
    if (application.ownedProcess.exitCode === null) await quit(application);
  }
});
