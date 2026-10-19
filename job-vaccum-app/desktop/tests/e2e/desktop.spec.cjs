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
  return mkdtemp(path.join(tempRoot, 'M1 app with spaces '));
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
  const exited = once(application.process(), 'exit');
  await application.evaluate(({ app }) => { app.quit(); });
  await exited;
}
const resize = (application, width, height) => application.evaluate(
  ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });
const noPageOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && document.documentElement.scrollHeight <= innerHeight);
const sidebarWidth = page => page.locator('#sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width));
const cssVar = (page, name) => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('shell, About with real backend, close/reopen, single instance and Quit', async () => {
  const dataDir = await directory();
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const options = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { size: window.getSize(), min: window.getMinimumSize(), lights: window.getWindowButtonPosition() };
    });
    expect(options).toEqual({ size: [1280, 800], min: [640, 480], lights: { x: 18, y: 17 } });

    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jobs');
    await expect(page.getByText('No jobs yet')).toBeVisible();
    await page.getByRole('button', { name: 'Shortlist' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shortlist');
    await expect(page.getByText('Your Shortlist is empty')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Runs/ })).toHaveCount(0);
    expect(await page.locator('.topbar').evaluate(el => getComputedStyle(el).webkitAppRegion)).toBe('drag');
    expect(await page.getByRole('button', { name: 'Hide sidebar' }).evaluate(el => getComputedStyle(el).webkitAppRegion)).toBe('no-drag');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'About' }).click();
    await expect(page.getByText('Ready · protocol v1')).toBeVisible();
    await expect(page.getByText('Schema 2 · WAL', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Version \d+\.\d+\.\d+ · macOS arm64$/)).toBeVisible();
    await expect(page.getByText(path.basename(dataDir), { exact: false })).toBeVisible();
    // Ping is a development-build diagnostic only.
    await expect(page.getByRole('button', { name: 'Ping' })).toHaveCount(packaged ? 0 : 1);
    if (!packaged) {
      await page.getByRole('button', { name: 'Ping' }).click();
      await expect(page.getByText(/^Replied in \d+ ms/)).toBeVisible();
    }
    await page.getByRole('button', { name: 'Run diagnostics' }).click();
    await expect(page.getByText('Read/write passed · schema 2 · WAL')).toBeVisible();
    await expect(page.getByText(packaged ? 'Bundled' : 'Development environment', { exact: true })).toBeVisible();

    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.evaluate(() => Object.keys(window.jobVaccum).sort())).toEqual([
      'addApplication', 'addApplications', 'chooseCsvDestination', 'deleteDirection', 'deleteQuery',
      'executeCleanup', 'exportCsv', 'getAppInfo', 'getConnection', 'getDiagnostics', 'getJobDetail', 'getSettings', 'getStatus',
      'importSyntheticJobs', 'listJobs', 'onConnectionChange', 'onServiceEvent', 'ping', 'previewCleanup', 'quit',
      'removeApplications', 'reorderDirections', 'restoreApplications', 'saveDirection', 'saveQuery',
      'saveSettings', 'setApplicationStatus', 'showCsvInFinder', 'showDataFolder', 'updateApplication',
    ]);
    expect(await page.evaluate(() => window.jobVaccum.ping('M1 中文 🙂'))).toEqual({ ok: true, result: { message: 'M1 中文 🙂' } });
    const invalid = await page.evaluate(() => window.jobVaccum.ping('x'.repeat(257)));
    expect(invalid.error.code).toBe('VALIDATION_ERROR');
    await page.screenshot({ path: path.join(dataDir, 'about.png') });

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
    await expect(newPage.getByRole('status')).toHaveText('Backend ready');
    expect(backendPid(application)).toBe(pid);
    expect(errors).toEqual([]);
    await quit(application);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { if (application.process().exitCode === null) await application.close(); }
});

test('sidebar collapse persists, narrow windows auto-collapse and restore', async () => {
  const dataDir = await directory();
  let application = await launch(dataDir);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    expect(await sidebarWidth(page)).toBe(200);

    // Narrow window collapses automatically and widening restores the expanded sidebar.
    await resize(application, 1000, 700);
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await page.screenshot({ path: path.join(dataDir, 'narrow-collapsed.png') });
    await resize(application, 1280, 800);
    await expect.poll(() => sidebarWidth(page)).toBe(200);

    // A manual collapse made in a narrow window is saved and survives widening.
    await resize(application, 1000, 700);
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect.poll(() => sidebarWidth(page)).toBe(200);
    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    await resize(application, 1280, 800);
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect.poll(() => sidebarWidth(page)).toBe(200);

    // ⌃⌘S collapses manually; that choice survives widening and a restart.
    await page.keyboard.press('Control+Meta+KeyS');
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    await resize(application, 1000, 700);
    await resize(application, 1280, 800);
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    await page.getByRole('button', { name: 'Shortlist' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shortlist');
    await page.screenshot({ path: path.join(dataDir, 'collapsed.png') });
    await quit(application);

    application = await launch(dataDir);
    page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    expect(await sidebarWidth(page)).toBe(52);
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect.poll(() => sidebarWidth(page)).toBe(200);
    await quit(application);

    application = await launch(dataDir);
    page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    expect(await sidebarWidth(page)).toBe(200);
  } finally { if (application.process().exitCode === null) await application.close(); }
});

test('themes and modes switch immediately, stay independent and persist', async () => {
  const dataDir = await directory();
  let application = await launch(dataDir);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    expect(await cssVar(page, '--sidebar')).toBe('#ececea');
    expect(await cssVar(page, '--accent')).toBe('#2a2a2d');
    const lightStatus = await cssVar(page, '--status-applied-bg');

    // System follows the OS scheme and uses the dark choice independently.
    await page.getByRole('radiogroup', { name: 'Dark theme' }).getByRole('radio', { name: 'Ink' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ink');
    expect(await cssVar(page, '--card')).toBe('#1d212a');
    expect(await cssVar(page, '--accent')).toBe('#93abe0');

    // Explicit Light ignores the OS dark scheme; the light theme choice is applied at once.
    await page.getByRole('radio', { name: 'Light', exact: true }).check();
    await page.getByRole('radiogroup', { name: 'Light theme' }).getByRole('radio', { name: 'Pine' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pine');
    expect(await cssVar(page, '--sidebar')).toBe('#ecede7');
    expect(await cssVar(page, '--accent')).toBe('#2f5d46');
    expect(await cssVar(page, '--status-applied-bg')).toBe(lightStatus);
    await page.screenshot({ path: path.join(dataDir, 'light-pine.png') });

    // Increased contrast deepens borders and secondary text.
    const border = await cssVar(page, '--border');
    await page.emulateMedia({ contrast: 'more' });
    expect(await cssVar(page, '--border')).not.toBe(border);
    expect(await cssVar(page, '--text-secondary')).toBe('#3a3a3c');
    await page.emulateMedia({ contrast: 'no-preference' });

    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ink');
    await page.screenshot({ path: path.join(dataDir, 'dark-ink.png') });
    await quit(application);

    application = await launch(dataDir);
    page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ink');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
    await expect(page.getByRole('radiogroup', { name: 'Light theme' }).getByRole('radio', { name: 'Pine' })).toBeChecked();
    await expect(page.getByRole('radiogroup', { name: 'Dark theme' }).getByRole('radio', { name: 'Ink' })).toBeChecked();
  } finally { if (application.process().exitCode === null) await application.close(); }
});

test('640 wide window, keyboard focus and reduced motion', async () => {
  const dataDir = await directory();
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await resize(application, 640, 480);
    await expect.poll(() => sidebarWidth(page)).toBe(52);
    for (const name of ['Jobs', 'Shortlist', 'Settings']) {
      await page.getByRole('button', { name }).click();
      expect(await noPageOverflow(page)).toBe(true);
    }
    await page.getByRole('button', { name: 'About' }).click();
    await page.getByRole('button', { name: 'Run diagnostics' }).click();
    await expect(page.getByText('Read/write passed · schema 2 · WAL')).toBeVisible();
    expect(await noPageOverflow(page)).toBe(true);
    // Long values wrap inside the card instead of widening the page.
    expect(await page.locator('.card').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(dataDir, 'narrow-about.png') });

    // Expanding while narrow is temporary and still fits.
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect.poll(() => sidebarWidth(page)).toBe(200);
    expect(await noPageOverflow(page)).toBe(true);
    await page.getByRole('button', { name: 'Hide sidebar' }).click();

    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.getByRole('button', { name: 'Appearance' }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'System' })).toBeFocused();
    expect(await page.locator('.segment').first().evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Light', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'About' }).click();
    await page.getByRole('button', { name: 'About' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Show in Finder' })).toBeFocused();
    expect(await page.getByRole('button', { name: 'Show in Finder' }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.screenshot({ path: path.join(dataDir, 'narrow-focus.png') });

    const button = page.getByRole('button', { name: 'Run diagnostics' });
    expect(await button.evaluate(el => getComputedStyle(el).transitionProperty)).toBe('transform, opacity');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await button.evaluate(el => getComputedStyle(el).transitionProperty)).toBe('opacity');
  } finally { await application.close(); }
});

test('startup failure is a whole-window page whose Quit exits the App', async () => {
  const dataDir = await directory();
  await writeFile(path.join(dataDir, 'app.sqlite3'), 'not a database');
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('alert')).toContainText("Job Vaccum can't open its data");
    await expect(page.getByText('STARTUP_ERROR', { exact: true })).toBeVisible();
    await expect(page.getByText(path.basename(dataDir), { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show in Finder' })).toBeVisible();
    await expect(page.locator('#sidebar')).toHaveCount(0);
    const quitButton = page.getByRole('button', { name: 'Quit Job Vaccum' });
    await expect(quitButton).toBeFocused();
    // Reason and fix come before the code.
    const order = await page.evaluate(() => {
      const text = document.querySelector('.failure').textContent;
      return text.indexOf('move the data folder aside') < text.indexOf('STARTUP_ERROR');
    });
    expect(order).toBe(true);
    await page.screenshot({ path: path.join(dataDir, 'startup-error.png') });
    const exited = once(application.process(), 'exit');
    await quitButton.click();
    await exited;
  } finally { if (application.process().exitCode === null) await application.close(); }
});

test('backend crash blocks the shell and only offers Quit', async () => {
  const dataDir = await directory();
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    process.kill(backendPid(application), 'SIGKILL');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText("Job Vaccum's backend stopped");
    await expect(dialog).toContainText('BACKEND_EXITED · signal SIGKILL');
    await expect(page.getByRole('status')).toHaveText('Backend stopped');
    await expect(page.getByRole('button', { name: 'Quit Job Vaccum' })).toBeFocused();
    expect(await page.locator('#sidebar').evaluate(el => el.inert)).toBe(true);
    await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeDisabled();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Quit Job Vaccum' })).toBeFocused();
    await page.screenshot({ path: path.join(dataDir, 'backend-stopped.png') });
    const exited = once(application.process(), 'exit');
    await page.getByRole('button', { name: 'Quit Job Vaccum' }).click();
    await exited;
  } finally { if (application.process().exitCode === null) await application.close(); }
});

test('controlled starting, loading and request error states remain usable', async () => {
  const dataDir = await directory();
  const application = await launch(dataDir);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'About' }).click();
    // Inject only at the Electron test boundary; no runtime test hooks ship in the app.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:connection-changed', { phase: 'starting' });
    });
    await expect(page.getByRole('status')).toHaveText('Starting backend…');
    await expect(page.getByRole('button', { name: 'Run diagnostics' })).toBeDisabled();
    await page.screenshot({ path: path.join(dataDir, 'starting.png') });
    const connection = await page.evaluate(() => window.jobVaccum.getConnection());
    await application.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:connection-changed', state);
    }, connection);
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:diagnostics');
      ipcMain.handle('app:diagnostics', () => new Promise(resolve => setTimeout(() => resolve({
        ok: false, error: { code: 'TIMEOUT', message: 'The backend request timed out.', retryable: true },
      }), 800)));
    });
    await page.getByRole('button', { name: 'Run diagnostics' }).click();
    await expect(page.getByRole('button', { name: 'Running…' })).toBeDisabled();
    await page.screenshot({ path: path.join(dataDir, 'loading.png') });
    await expect(page.getByRole('alert')).toContainText('The backend request timed out.');
    await expect(page.getByRole('alert')).toContainText('TIMEOUT');
    await expect(page.getByRole('button', { name: 'Run diagnostics' })).toBeEnabled();
    await page.screenshot({ path: path.join(dataDir, 'request-error.png') });
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
    await expect(page.getByRole('status')).toHaveText('Backend ready');
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
    await expect(page.getByRole('status')).toHaveText('Backend ready');
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

test('CSV resolved destinations cannot reach application data or be retargeted after selection', async () => {
  test.skip(Boolean(packaged), 'Uses development synthetic fixtures');
  const { readFile, symlink, unlink, rm } = require('node:fs/promises');
  const dataDir = await directory();
  const outsideDir = await directory();
  const dataAlias = path.join(outsideDir, 'data-alias');
  await symlink(dataDir, dataAlias, 'dir');
  // Launch through an alias as well, so the protected root must be resolved.
  const application = await launch(dataAlias);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    await page.evaluate(() => window.jobVaccum.importSyntheticJobs({ count: 3 }));
    const database = path.join(dataDir, 'app.sqlite3');
    const fileAlias = path.join(outsideDir, 'export.csv');
    await symlink(database, fileAlias);
    for (const destination of [fileAlias, path.join(dataAlias, 'new.csv'), path.join(dataAlias, 'app.sqlite3')]) {
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, destination);
      const chosen = await page.evaluate(() => window.jobVaccum.chooseCsvDestination());
      expect(chosen.ok).toBe(false);
      expect(chosen.error.code).toBe('VALIDATION_ERROR');
    }
    const pendingPath = path.join(outsideDir, 'pending.csv');
    await writeFile(pendingPath, 'ordinary external file');
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, pendingPath);
    const chosen = await page.evaluate(() => window.jobVaccum.chooseCsvDestination());
    expect(chosen.ok).toBe(true);
    await unlink(pendingPath);
    await symlink(database, pendingPath);
    const result = await page.evaluate(destination_token => window.jobVaccum.exportCsv({
      scope: 'discover', range: 'all', include_jd: false, destination_token,
    }), chosen.result.destination_token);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect((await readFile(database)).subarray(0, 16).toString('ascii')).toBe('SQLite format 3\0');
    expect((await page.evaluate(() => window.jobVaccum.listJobs({}))).result.total).toBe(3);
    expect((await page.evaluate(() => window.jobVaccum.getDiagnostics())).ok).toBe(true);
  } finally {
    await application.close();
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('oversized business responses keep the connection ready and preserve bulk Undo data', async () => {
  test.skip(Boolean(packaged), 'Uses development synthetic fixtures');
  const application = await launch(await directory());
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('status')).toHaveText('Backend ready');
    const result = await page.evaluate(async () => {
      const api = window.jobVaccum;
      await api.importSyntheticJobs({ count: 200 });
      const jobs = await api.listJobs({ page_size: 200 });
      const job_ids = jobs.result.items.map(item => item.id);
      await api.addApplications({ job_ids });
      for (const job_id of job_ids) {
        const saved = await api.updateApplication({ job_id, notes: 'x'.repeat(6000) });
        if (!saved.ok) throw new Error(saved.error.message);
      }
      const large = await api.listJobs({ scope: 'applications', page_size: 200 });
      const removal = await api.removeApplications({ job_ids });
      const small = await api.listJobs({ scope: 'applications', page_size: 50 });
      const ping = await api.ping('still connected');
      const connection = await api.getConnection();
      const removed = await api.removeApplications({ job_ids: job_ids.slice(0, 50) });
      const restored = await api.restoreApplications({ items: removed.result.items });
      const after = await api.listJobs({ scope: 'applications', page_size: 1 });
      return { large, removal, smallCount: small.result.total, smallItems: small.result.items.length,
        allNotesIntact: small.result.items.every(item => item.application.notes === 'x'.repeat(6000)),
        ping, connection, restored, afterCount: after.result.total };
    });
    expect(result.large.error.code).toBe('RESPONSE_TOO_LARGE');
    expect(result.removal.error.code).toBe('RESPONSE_TOO_LARGE');
    expect(result.smallCount).toBe(200);
    expect(result.smallItems).toBe(50);
    expect(result.allNotesIntact).toBe(true);
    expect(result.ping.result.message).toBe('still connected');
    expect(result.connection.phase).toBe('ready');
    expect(result.restored.result.counts.restored).toBe(50);
    expect(result.afterCount).toBe(200);
  } finally { await application.close(); }
});
