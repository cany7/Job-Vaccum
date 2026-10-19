const { test, expect, _electron: electron } = require('@playwright/test');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const tempRoot = path.resolve(root, '../../tmp/job-vaccum-app');
const packaged = process.env.JV_EXECUTABLE;

async function launch(dataDir) {
  return electron.launch({
    executablePath: packaged || require('electron'),
    args: [...(packaged ? [] : [root]), `--data-dir=${dataDir}`],
    cwd: '/', env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
}
async function directory() {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, 'M0 app with spaces '));
}
function backendPid(application) {
  const parent = application.process().pid;
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  const row = rows.find(row => {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match && Number(match[2]) === parent && /job_vaccum|job-vaccum-service/.test(match[3]);
  });
  if (!row) throw new Error('Owned backend process missing');
  return Number(row.trim().split(/\s+/)[0]);
}
async function quit(application) {
  await application.evaluate(({ app }) => { app.quit(); });
  await once(application.process(), 'exit');
}

test('real bridge, offline diagnostics, responsive window, close/reopen and single instance', async () => {
  const dataDir = await directory();
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
    await expect(page.getByText('None', { exact: true })).toHaveCount(2);
    await page.getByLabel('Message').fill('M0 中文 🙂');
    await page.getByLabel('Message').press('Enter');
    await expect(page.getByText('M0 中文 🙂', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run diagnostics' }).click();
    await expect(page.getByText('Read/write passed · schema 2 · WAL')).toBeVisible();
    await expect(page.getByText(packaged ? 'Bundled' : 'Development environment', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.evaluate(() => Object.keys(window.jobVaccum).sort())).toEqual([
      'addApplication', 'addApplications', 'chooseCsvDestination', 'deleteDirection', 'deleteQuery',
      'executeCleanup', 'exportCsv', 'getConnection', 'getDiagnostics', 'getJobDetail', 'getSettings', 'getStatus',
      'importSyntheticJobs', 'listJobs', 'onConnectionChange', 'onServiceEvent', 'ping', 'previewCleanup',
      'removeApplications', 'reorderDirections', 'restoreApplications', 'saveDirection', 'saveQuery',
      'saveSettings', 'setApplicationStatus', 'showCsvInFinder', 'updateApplication',
    ]);
    const invalid = await page.evaluate(() => window.jobVaccum.ping('x'.repeat(257)));
    expect(invalid.error.code).toBe('VALIDATION_ERROR');
    await page.screenshot({ path: path.join(dataDir, 'connected.png'), fullPage: true });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 480));
    await page.getByLabel('Message').fill('long-'.repeat(51));
    await page.getByLabel('Message').press('Enter');
    await expect(page.getByText('long-'.repeat(51), { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Message').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Send ping' })).toBeFocused();
    expect(await page.getByRole('button', { name: 'Send ping' }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.getByRole('button', { name: 'Send ping' }).evaluate(el => getComputedStyle(el).transitionProperty)).toBe('opacity');
    await page.screenshot({ path: path.join(dataDir, 'narrow-focus.png'), fullPage: true });

    const pid = backendPid(application);
    const second = spawn(packaged || require('electron'), [...(packaged ? [] : [root]), `--data-dir=${dataDir}`], { cwd: '/', stdio: 'ignore' });
    const [code] = await once(second, 'exit');
    expect(code).toBe(0);
    expect(backendPid(application)).toBe(pid);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(backendPid(application)).toBe(pid);
    const reopened = application.waitForEvent('window');
    await application.evaluate(({ app }) => app.emit('activate'));
    const newPage = await reopened;
    await expect(newPage.getByRole('status')).toHaveText('Connected');
    await expect(newPage.getByText('Not configured', { exact: true })).toBeVisible();
    expect(backendPid(application)).toBe(pid);
    expect(errors).toEqual([]);
    await quit(application);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { if (application.process().exitCode === null) await application.close(); }
});

test('startup error is visible and requests are disabled', async () => {
  const dataDir = await directory();
  await writeFile(path.join(dataDir, 'app.sqlite3'), 'not a database');
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('alert')).toContainText('The local backend failed to start');
    await expect(page.getByRole('button', { name: 'Send ping' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh status' })).toBeDisabled();
    await page.screenshot({ path: path.join(dataDir, 'startup-error.png'), fullPage: true });
  } finally { await application.close(); }
});

test('backend crash appears in the window without losing last status', async () => {
  const application = await launch(await directory());
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
    process.kill(backendPid(application), 'SIGKILL');
    await expect(page.getByRole('alert')).toContainText('The local backend stopped');
    await expect(page.getByText('Last known status; the backend is not connected.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send ping' })).toBeDisabled();
  } finally { await application.close(); }
});

test('controlled connection, loading and request error states remain usable', async () => {
  const dataDir = await directory();
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Connected');
    // Inject only at the Electron test boundary; no runtime test hooks ship in the app.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:connection-changed', { phase: 'starting' });
    });
    await expect(page.getByText('Waiting for the backend handshake…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send ping' })).toBeDisabled();
    await page.screenshot({ path: path.join(dataDir, 'starting.png'), fullPage: true });
    const connection = await page.evaluate(() => window.jobVaccum.getConnection());
    await application.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:connection-changed', state);
    }, connection);
    await expect(page.getByRole('status')).toHaveText('Connected');
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:ping');
      ipcMain.handle('app:ping', () => new Promise(resolve => setTimeout(() => resolve({
        ok: false, error: { code: 'VALIDATION_ERROR', message: 'Synthetic validation error.', retryable: false },
      }), 800)));
    });
    await page.getByRole('button', { name: 'Send ping' }).click();
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await page.screenshot({ path: path.join(dataDir, 'loading.png'), fullPage: true });
    await expect(page.getByRole('alert')).toContainText('Synthetic validation error.');
    await expect(page.getByRole('button', { name: 'Send ping' })).toBeEnabled();
    await expect(page.getByLabel('Message')).toHaveValue('hello');
    await page.screenshot({ path: path.join(dataDir, 'request-error.png'), fullPage: true });
  } finally { await application.close(); }
});

test('M1 named bridge persists business data and exports through a main-owned destination', async () => {
  test.skip(Boolean(packaged), 'Development synthetic import is intentionally disabled in packaged apps');
  const { readFile, rm } = require('node:fs/promises');
  const dataDir = await directory();
  const csvPath = path.join(tempRoot, `M1-export-${path.basename(dataDir)}.csv`);
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Connected');
    const result = await page.evaluate(async () => {
      const api = window.jobVaccum;
      const imported = await api.importSyntheticJobs({ count: 125 });
      const first = await api.listJobs({ page_size: 50 });
      const id = first.result.items[0].id;
      const added = await api.addApplications({ job_ids: [id, id, 'missing'] });
      const edited = await api.updateApplication({ job_id: id, notes: 'Synthetic note', status: 'oa' });
      const changed = await api.setApplicationStatus({ job_ids: [id], status: 'offer' });
      const snapshots = changed.result.items.map(({ outcome, ...item }) => item);
      await api.restoreApplications({ items: snapshots });
      const removed = await api.removeApplications({ job_ids: [id] });
      await api.restoreApplications({ items: removed.result.items });
      const detail = await api.getJobDetail({ job_id: id });
      await api.saveSettings({ retention_days: 0 });
      return { imported, first, added, edited, detail, id };
    });
    expect(result.imported.result.added_count).toBe(125);
    expect(result.first.result.total).toBe(125);
    expect(result.first.result.items).toHaveLength(50);
    expect(result.first.result.items[0].description).toBeUndefined();
    expect(result.added.result.counts).toEqual({ added: 1, already_present: 0, not_found: 1 });
    expect(result.detail.result.application.notes).toBe('Synthetic note');
    expect(result.detail.result.application.status).toBe('oa');

    const invalidPath = await page.evaluate(() => window.jobVaccum.exportCsv({
      scope: 'discover', range: 'all', include_jd: false, destination_token: 'forged', destination_path: '/tmp/forged.csv',
    }));
    expect(invalidPath.error.code).toBe('VALIDATION_ERROR');
    // Only the native save-panel boundary is mocked; all IPC and Python CSV work is real.
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, csvPath);
    const token = await page.evaluate(async () => (await window.jobVaccum.chooseCsvDestination()).result.destination_token);
    const completed = await page.evaluate(async destination_token => {
      const api = window.jobVaccum;
      const events = [];
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Export event timed out')); }, 5000);
        const unsubscribe = api.onServiceEvent(event => {
          events.push(event);
          if (event.name === 'operation.completed' || event.name === 'operation.failed') {
            clearTimeout(timeout); unsubscribe(); resolve(event);
          }
        });
      });
      const result = await api.exportCsv({ scope: 'discover', range: 'filtered', include_jd: true, destination_token });
      if (!result.ok) throw new Error(result.error.message);
      return { started: result, completed: await done };
    }, token);
    expect(completed.completed.name).toBe('operation.completed');
    expect(completed.completed.data.row_count).toBe(125);
    expect(completed.completed.data.operation_id).toBe(completed.started.result.operation_id);
    const csv = await readFile(csvPath);
    expect(csv.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(csv.toString('utf8')).toContain('Complete synthetic JD');
    const used = await page.evaluate(destination_token => window.jobVaccum.exportCsv({ scope: 'discover', range: 'all', include_jd: false, destination_token }), token);
    expect(used.error.code).toBe('VALIDATION_ERROR');
    // A successfully completed token can only reveal its own export path.
    await application.evaluate(({ shell }) => { shell.showItemInFolder = () => {}; });
    expect((await page.evaluate(destination_token => window.jobVaccum.showCsvInFinder({ destination_token }), token)).ok).toBe(true);
    expect((await page.evaluate(() => window.jobVaccum.showCsvInFinder({ destination_token: 'forged' }))).ok).toBe(false);
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, path.join(dataDir, 'app.sqlite3'));
    expect((await page.evaluate(() => window.jobVaccum.chooseCsvDestination())).ok).toBe(false);
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    expect((await page.evaluate(() => window.jobVaccum.chooseCsvDestination())).result).toBe(null);
    await quit(application);
  } finally {
    if (application.process().exitCode === null) await application.close();
    await rm(csvPath, { force: true });
  }
  const restarted = await launch(dataDir);
  try {
    const page = await restarted.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Connected');
    const state = await page.evaluate(async () => ({
      settings: await window.jobVaccum.getSettings(),
      jobs: await window.jobVaccum.listJobs({}),
      applications: await window.jobVaccum.listJobs({ scope: 'applications' }),
    }));
    expect(state.settings.result.retention_days).toBe(0);
    expect(state.jobs.result.total).toBe(125);
    expect(state.applications.result.items[0].application.notes).toBe('Synthetic note');
  } finally { await restarted.close(); }
});
