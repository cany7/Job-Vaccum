// Helpers for the M1 list tests. Data is public synthetic fixtures written by the
// development backend before the app starts, so the same tests run against an
// installed copy (JV_EXECUTABLE) whose own backend refuses dev commands.
const { _electron: electron, expect } = require('@playwright/test');
const { mkdtemp, mkdir } = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const backendRoot = path.resolve(root, '../backend');
const tempRoot = path.resolve(root, '../../tmp/job-vaccum-app');
const packaged = process.env.JV_EXECUTABLE;

/** Synthetic fixture i (see backend storage/synthetic.py). */
const jobId = i => `00000000-0000-0000-0000-${(1000 + i).toString(16).padStart(12, '0')}`;
const fixture = i => ({
  id: jobId(i),
  title: `Synthetic Engineer ${String(i).padStart(4, '0')}`,
  score: i % 4 === 0 ? null : i % 11,
  directions: i % 3 === 0 ? ['Software', 'Data'] : [i % 2 ? 'Data' : 'Software'],
});

async function directory() {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, 'M1 lists '));
}

/** Runs protocol requests on the development backend, then lets it exit. */
async function seed(dataDir, requests, sql) {
  const child = spawn(path.join(backendRoot, '.venv/bin/python'), ['-m', 'job_vaccum', '--data-dir', dataDir, '--enable-dev-commands'],
    { cwd: backendRoot, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.type !== 'response') return;
    pending.get(message.id)?.(message);
  });
  const results = [];
  for (const [index, [method, params]] of requests.entries()) {
    const id = `seed-${index}`;
    const response = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ type: 'request', id, method, params }) + '\n');
    const message = await response;
    if (!message.ok) throw new Error(`${method}: ${message.error.message}`);
    results.push(message.result);
  }
  child.stdin.end();
  await once(child, 'exit');
  // Score states other than unscored/succeeded only come from M3 workers; set them directly for UI coverage.
  if (sql) execFileSync('/usr/bin/sqlite3', [path.join(dataDir, 'app.sqlite3'), sql]);
  return results;
}

async function launch(dataDir) {
  const application = await electron.launch({
    executablePath: packaged || require('electron'),
    args: [...(packaged ? [] : [root]), `--data-dir=${dataDir}`],
    cwd: '/', env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  application.ownedProcess = application.process();
  const page = await application.firstWindow();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await expect(page.locator('.sidebar-status')).toHaveAttribute('data-connection', 'ready');
  return { application, page };
}

async function quit(application) {
  const exited = once(application.ownedProcess, 'exit');
  await application.evaluate(({ app }) => { app.quit(); });
  await exited;
}

const resize = (application, width, height) => application.evaluate(
  ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });
const nav = (page, name) => page.locator('#sidebar').getByRole('button', { name: new RegExp(`^${name}`) }).first();
const view = page => page.locator('.list-view:not([hidden])');
const rows = page => view(page).locator('tbody tr');
const row = (page, title) => rows(page).filter({ hasText: title });
const range = page => view(page).locator('.pager-range');
const toast = page => page.getByRole('region', { name: 'Notifications' }).locator('.toast');
const noPageOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && document.documentElement.scrollHeight <= innerHeight);

module.exports = {
  packaged, tempRoot, jobId, fixture, directory, seed, launch, quit, resize, nav, view, rows, row, range, toast, noPageOverflow,
};
