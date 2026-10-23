const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { directory, launch, quit } = require('./support.cjs');

function sql(dir, statement) {
  return execFileSync('/usr/bin/sqlite3', ['-cmd', '.timeout 5000', path.join(dir, 'app.sqlite3'), statement], { encoding: 'utf8' }).trim();
}

test('M7 named bridge, no-window clock, hidden Dock/tray, reopen and preferences', { tag: '@smoke' }, async () => {
  test.setTimeout(90000);
  const dir = await directory();
  let { application, page } = await launch(dir);
  try {
    expect(await page.evaluate(() => window.jobVaccum.getDesktopPreferences())).toEqual({ show_menu_bar_icon: true });
    await page.evaluate(() => window.jobVaccum.setDesktopPreferences({ show_menu_bar_icon: false }));
    const saved = await page.evaluate(() => window.jobVaccum.saveSchedule({ enabled: false, direction_ids: null, time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' }));
    expect(saved.ok).toBe(true);
    expect((await page.evaluate(() => window.jobVaccum.listSchedules())).result.items).toHaveLength(1);
    expect(await page.evaluate(() => 'triggerSchedule' in window.jobVaccum)).toBe(false);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => application.evaluate(({ app, BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().length, dock: app.dock.isVisible() }))).toEqual({ windows: 0, dock: false });
    // Introduce a due occurrence while there is no renderer. No searches are
    // configured: the real service records a validation failure, with no network.
    const at = new Date(Date.now() + 60000);
    const wall = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
    sql(dir, `UPDATE schedules SET enabled=1,time_local='${wall}',checked_at=${Date.now()} WHERE id='${saved.result.id}';`);
    await expect.poll(() => sql(dir, "SELECT count(*) FROM runs WHERE status='failed' AND json_extract(trigger_json,'$.source')='schedule';"), { timeout: 65000 }).toBe('1');
    expect(sql(dir, "SELECT outcome FROM schedule_firings;")).toBe('started');
    const reopened = application.waitForEvent('window');
    await application.evaluate(({ app }) => app.emit('activate'));
    page = await reopened;
    await expect.poll(() => application.evaluate(({ app }) => app.dock.isVisible())).toBe(true);
    await expect(page.locator('.sidebar-status')).toHaveAttribute('data-connection', 'ready');
    const listing = await page.evaluate(() => window.jobVaccum.listSchedules());
    expect(listing.result.firings).toHaveLength(1);
    await quit(application);
    ({ application, page } = await launch(dir));
    expect(await page.evaluate(() => window.jobVaccum.getDesktopPreferences())).toEqual({ show_menu_bar_icon: false });
    expect((await page.evaluate(() => window.jobVaccum.listSchedules())).result.firings).toHaveLength(1);
    await page.evaluate(id => window.jobVaccum.deleteSchedule({ id }), saved.result.id);
    expect(sql(dir, 'SELECT count(*) FROM runs;')).toBe('1');
    expect(page.errors).toEqual([]);
  } finally { if (application.ownedProcess.exitCode === null) await quit(application); }
});

test('M7 running/stopping Quit confirms, Cancel preserves service and close never confirms', async () => {
  const dir = await directory();
  const { application } = await launch(dir);
  try {
    // Committed synthetic active state; no worker/network is started by this fixture.
    sql(dir, `INSERT INTO runs(id,kind,status,created_at,started_at,config_snapshot_json) VALUES ('synthetic','pipeline','stopping',1,1,'{}');`);
    await application.evaluate(({ dialog }) => {
      global.quitPrompts = [];
      global.quitChoice = 0;
      dialog.showMessageBox = async options => { global.quitPrompts.push(options); return { response: global.quitChoice }; };
    });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(await application.evaluate(() => global.quitPrompts.length)).toBe(0);
    await application.evaluate(({ app }) => app.quit());
    await expect.poll(() => application.evaluate(() => global.quitPrompts.length)).toBe(1);
    const prompt = await application.evaluate(() => global.quitPrompts[0]);
    expect(prompt.defaultId).toBe(0); expect(prompt.cancelId).toBe(0);
    expect(prompt.message).toBe('A run is in progress. Quitting stops it; finished tasks are kept and you can resume later.');
    expect(application.ownedProcess.exitCode).toBe(null);
    expect(sql(dir, "SELECT status FROM runs WHERE id='synthetic';")).toBe('stopping');
    await application.evaluate(() => { global.quitChoice = 1; });
    await quit(application);
    expect(sql(dir, "SELECT status FROM runs WHERE id='synthetic';")).toBe('stopped');
  } finally { if (application.ownedProcess.exitCode === null) { application.ownedProcess.kill('SIGTERM'); await once(application.ownedProcess, 'exit'); } }
});


test('M7 terminal shutdown stays bounded even while a quit dialog is unanswered', async () => {
  const dir = await directory();
  const { application } = await launch(dir);
  try {
    sql(dir, `INSERT INTO runs(id,kind,status,created_at,started_at,config_snapshot_json) VALUES ('synthetic','pipeline','stopping',1,1,'{}');`);
    await application.evaluate(({ dialog, app }) => {
      global.promptOpen = false;
      dialog.showMessageBox = () => { global.promptOpen = true; return new Promise(() => {}); };
      app.quit();
    });
    await expect.poll(() => application.evaluate(() => global.promptOpen)).toBe(true);
    const exited = once(application.ownedProcess, 'exit');
    const started = Date.now();
    application.ownedProcess.kill('SIGTERM');
    await exited;
    expect(Date.now() - started).toBeLessThan(12000);
    expect(sql(dir, "SELECT status FROM runs WHERE id='synthetic';")).toBe('stopped');
  } finally { if (application.ownedProcess.exitCode === null) application.ownedProcess.kill('SIGKILL'); }
});
