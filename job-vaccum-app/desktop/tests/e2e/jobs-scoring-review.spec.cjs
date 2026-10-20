// B14: synthetic persisted states, real list counts, shared Jobs/Shortlist UI.
const { test, expect } = require('@playwright/test');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { directory, seed, launch, quit, nav, view, row, rows, jobId, fixture, resize, noPageOverflow } = require('./support.cjs');
const scoreButton = page => page.locator('.topbar-actions').getByRole('button', { name: 'Score', exact: true });
const title = i => fixture(i).title;

test('B14 score states, confirmation counts, menu input and responsive appearance', async () => {
  test.setTimeout(90_000);
  const dataDir = await directory();
  await seed(dataDir, [
    ['dev.import_synthetic', { count: 12 }],
    ['settings.save', { retention_days: 0, auto_score_enabled: false, rubric: 'Synthetic rubric',
      model: { protocol: 'chat_completions', model_id: 'private-model-id', base_url: 'http://127.0.0.1:9999' } }],
    ['applications.add_many', { job_ids: [0, 1, 2, 3, 4, 11].map(jobId) }],
  ], `UPDATE jobs SET score_state='failed', last_score_error='Synthetic failure · HTTP 400' WHERE id IN ('${jobId(0)}','${jobId(2)}','${jobId(11)}');
      UPDATE jobs SET score_state='pending' WHERE id='${jobId(1)}';
      UPDATE jobs SET score_state='running' WHERE id='${jobId(3)}';`);
  const shots = path.join(dataDir, 'jobs-review');
  await mkdir(shots);
  console.log(`B14 screenshots: ${shots}`);
  const { application, page } = await launch(dataDir);
  try {
    await nav(page, 'Settings').click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByLabel('API key').fill('synthetic-review-key');
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByRole('button', { name: 'Replace key' })).toBeVisible();
    await nav(page, 'Jobs').click();
    await expect(rows(page)).toHaveCount(12);
    await expect(row(page, title(0)).locator('.score')).toHaveText('!');
    await expect(row(page, title(2)).locator('.score')).toHaveText('2');
    await expect(row(page, title(11)).locator('.score')).toHaveText('0');
    await expect(row(page, title(11)).locator('.score')).toHaveAttribute('data-retry-failed', 'true');
    await expect(row(page, title(1)).locator('.score svg')).toBeVisible();
    await expect(row(page, title(3)).locator('.score')).toHaveText('');
    await expect(row(page, title(4)).locator('.score')).toHaveText('—');

    // Pointer opening leaves all items unselected, but arrows still work immediately.
    await scoreButton(page).click();
    await expect(page.locator('.menu-item:focus')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Score all 12 matching…' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(scoreButton(page)).toBeFocused();
    await scoreButton(page).press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Score all 12 matching…' })).toBeFocused();
    await page.keyboard.press('Escape');
    await row(page, title(0)).getByRole('checkbox').check();
    await scoreButton(page).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('menuitem', { name: 'Score selected (1)' })).toBeFocused();
    await page.keyboard.press('Escape');

    // The zero score and both preserved scores count as scored, regardless of state.
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score all 12 matching…' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('9 already scored will be rescored · 3 unscored');
    await expect(dialog).toContainText('Every job in Jobs (12) is scored');
    await expect(dialog).not.toContainText('private-model-id');
    await expect(dialog).not.toContainText('127.0.0.1');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // A narrow score range must not be widened by the scored-count query.
    await view(page).getByRole('button', { name: '+ Filter' }).click();
    await page.getByRole('menuitem', { name: 'Score', exact: true }).click();
    await page.getByLabel('Lowest score').fill('6');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rows(page)).toHaveCount(4);
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score all 4 matching…' }).click();
    await expect(page.getByRole('dialog')).toContainText('4 already scored will be rescored · 0 unscored');
    await expect(page.locator('.score-filter-tags .chip')).toHaveText(['Score ≥ 6']);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await view(page).getByRole('button', { name: 'Clear all', exact: true }).click();

    // Failed rescores still sort and filter by the retained value, including zero.
    await view(page).getByRole('columnheader').getByRole('button', { name: 'Score', exact: true }).click();
    await expect(rows(page).first().locator('.score')).toHaveText('10');
    await view(page).getByRole('columnheader').getByRole('button', { name: 'Score', exact: true }).click();
    await expect(rows(page).first().locator('.score')).toHaveText('0');
    await expect(rows(page).first().locator('.score')).toHaveAttribute('data-retry-failed', 'true');
    await view(page).getByRole('button', { name: '+ Filter' }).click();
    await page.getByRole('menuitem', { name: 'Score', exact: true }).click();
    await page.getByLabel('Lowest score').fill('0');
    await page.getByLabel('Highest score').fill('0');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(title(11));
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score all 1 matching…' }).click();
    await expect(page.getByRole('dialog')).toContainText('1 already scored will be rescored · 0 unscored');
    await expect(page.locator('.score-filter-tags .chip')).toHaveText(['Score 0']);
    await page.screenshot({ animations: 'disabled', path: path.join(shots, 'filtered-confirm.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await view(page).getByRole('button', { name: 'Clear all', exact: true }).click();

    // Actual windows, both schemes and minimum size, including reduced motion.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const scheme of ['Light', 'Dark']) {
      await nav(page, 'Settings').click();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.getByRole('radio', { name: scheme, exact: true }).check();
      for (const [width, height] of [[1280, 800], [640, 480]]) {
        await resize(application, width, height);
        await nav(page, 'Jobs').click();
        await row(page, title(2)).locator(".cell-score").click();
        const drawer = page.getByRole('complementary', { name: 'Job details' });
        await expect(drawer).toContainText('Last attempt failed · Synthetic failure · HTTP 400');
        await expect(drawer).toContainText('2 · ');
        await expect(drawer).toContainText('fake-model');
        await page.screenshot({ animations: 'disabled', path: path.join(shots, `${scheme}-${width}-failed.png`) });
        await row(page, title(1)).locator(".cell-score").click();
        await expect(drawer.locator('.score-large')).toHaveAttribute('data-tone', 'pending');
        await page.screenshot({ animations: 'disabled', path: path.join(shots, `${scheme}-${width}-pending.png`) });
        await view(page).getByRole('button', { name: 'Close details' }).click();
        await scoreButton(page).click();
        await page.getByRole('menuitem', { name: 'Score all 12 matching…' }).hover();
        await page.screenshot({ animations: 'disabled', path: path.join(shots, `${scheme}-${width}-menu.png`) });
        await page.getByRole('menuitem', { name: 'Score all 12 matching…' }).click();
        await expect(page.getByRole('dialog')).toContainText('9 already scored');
        await expect(page.getByRole('dialog').getByRole('button', { name: 'Score 12 jobs', exact: true })).toBeEnabled();
        await page.screenshot({ animations: 'disabled', path: path.join(shots, `${scheme}-${width}-confirm.png`) });
        expect(await noPageOverflow(page)).toBe(true);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await nav(page, 'Shortlist').click();
        await row(page, title(11)).locator(".cell-score").click();
        await expect(page.getByRole('complementary', { name: 'Job details' })).toContainText('Last attempt failed');
        await page.screenshot({ animations: 'disabled', path: path.join(shots, `${scheme}-${width}-shortlist.png`) });
        await view(page).getByRole('button', { name: 'Close details' }).click();
        await scoreButton(page).click();
        await page.getByRole('menuitem', { name: 'Score all 6 matching…' }).click();
        await expect(page.getByRole('dialog')).toContainText('4 already scored will be rescored · 2 unscored');
        await expect(page.getByRole('dialog')).toContainText('Every job in Shortlist (6) is scored');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await noPageOverflow(page)).toBe(true);
      }
    }
    // A failed count never enables a paid scoring action; closing remains available.
    await nav(page, 'Jobs').click();
    await application.evaluate(({ ipcMain }) => {
      globalThis.reviewList = ipcMain._invokeHandlers.get('jobs:list');
      ipcMain.removeHandler('jobs:list');
      ipcMain.handle('jobs:list', () => new Promise(resolve => setTimeout(() => resolve({
        ok: false, error: { code: 'TIMEOUT', message: 'Synthetic count failure', retryable: true },
      }), 700)));
    });
    await scoreButton(page).click();
    await page.getByRole('menuitem', { name: 'Score all 12 matching…' }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Counting matching jobs…');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Score jobs', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('Synthetic count failure');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Score jobs', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('jobs:list');
      ipcMain.handle('jobs:list', globalThis.reviewList);
    });
    expect(page.errors).toEqual([]);
  } finally { await quit(application); }
});
