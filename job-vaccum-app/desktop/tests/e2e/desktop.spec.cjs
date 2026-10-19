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
    await expect(page.getByText('Read/write passed · schema 1 · WAL')).toBeVisible();
    await expect(page.getByText(packaged ? 'Bundled' : 'Development environment', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.evaluate(() => Object.keys(window.jobVaccum).sort())).toEqual([
      'getConnection', 'getDiagnostics', 'getStatus', 'onConnectionChange', 'ping',
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
