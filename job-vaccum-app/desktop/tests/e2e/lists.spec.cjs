const { test, expect } = require('@playwright/test');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const {
  packaged, tempRoot, jobId, fixture, directory, seed, launch, quit, resize, nav, view, rows, row, range, toast, noPageOverflow,
} = require('./support.cjs');

const title = i => fixture(i).title;
const header = (page, name) => view(page).getByRole('columnheader', { name: new RegExp(`^${name}`) });
const selectBox = page => view(page).locator('.select-box');
const selectedCount = page => view(page).locator('.selected-count');
const chips = page => view(page).locator('.chip-label');
const detailTitle = page => view(page).locator('.detail-heading h2');
const import125 = ['dev.import_synthetic', { count: 125 }];

test('Jobs: paging, sorting, selection, adding and keyboard review', { tag: '@smoke' }, async () => {
  const dataDir = await directory();
  await seed(dataDir, [import125]);
  let { application, page } = await launch(dataDir);
  try {
    await expect(nav(page, 'Jobs')).toContainText('125');
    await expect(rows(page)).toHaveCount(50);
    await expect(range(page)).toHaveText('1–50 of 125');
    await expect(page.locator('.page-subtitle')).toHaveText('All searches · 125 jobs');
    const previous = view(page).getByRole('button', { name: 'Previous page' });
    const next = view(page).getByRole('button', { name: 'Next page' });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range(page)).toHaveText('51–100 of 125');
    await next.click();
    await expect(range(page)).toHaveText('101–125 of 125');
    await expect(rows(page)).toHaveCount(25);
    await expect(next).toBeDisabled();
    await range(page).click();
    await page.getByRole('menuitem', { name: 'First page' }).click();
    await expect(range(page)).toHaveText('1–50 of 125');
    await range(page).click();
    await page.getByRole('menuitemcheckbox', { name: '100' }).click();
    await expect(range(page)).toHaveText('1–100 of 125');
    await expect(rows(page)).toHaveCount(100);

    // Sorting: scores and dates start high, text starts A→Z; empty scores stay last.
    await header(page, 'Score').getByRole('button').click();
    await expect(header(page, 'Score')).toHaveAttribute('aria-sort', 'descending');
    await expect(rows(page).first().locator('.score')).toHaveText('10');
    await header(page, 'Score').getByRole('button').click();
    await expect(header(page, 'Score')).toHaveAttribute('aria-sort', 'ascending');
    await expect(rows(page).first().locator('.score')).toHaveText('0');
    await expect(rows(page).nth(93).locator('.score')).toHaveText('—');
    await header(page, 'Role').getByRole('button').click();
    await expect(header(page, 'Role')).toHaveAttribute('aria-sort', 'ascending');
    await expect(header(page, 'Score')).not.toHaveAttribute('aria-sort', /.+/);
    await expect(rows(page).first()).toContainText(title(0));
    for (const name of ['Why', 'Searches']) await expect(header(page, name).getByRole('button')).toHaveCount(0);
    await expect(rows(page).nth(3).locator('.cell-directions')).toHaveText('Software, Data');

    // Selection: the box selects the page or clears; ▾ replaces the selection by a condition.
    await selectBox(page).click();
    await expect(selectedCount(page)).toHaveText('100 selected');
    await expect(selectBox(page)).toHaveAttribute('aria-checked', 'true');
    await selectBox(page).click();
    await expect(selectedCount(page)).toHaveCount(0);
    await rows(page).nth(0).getByRole('checkbox').check();
    await view(page).getByRole('button', { name: 'Select by condition' }).click();
    await page.getByRole('menuitem', { name: 'Score 8+' }).click();
    const high = Array.from({ length: 100 }, (_, i) => fixture(i)).filter(job => job.score >= 8).length;
    await expect(selectedCount(page)).toHaveText(`${high} selected`);
    await expect(rows(page).nth(0).getByRole('checkbox')).not.toBeChecked();
    await selectBox(page).click();
    await rows(page).nth(1).getByRole('checkbox').click();
    await rows(page).nth(4).getByRole('checkbox').click({ modifiers: ['Shift'] });
    await expect(selectedCount(page)).toHaveText('4 selected');
    await expect(selectBox(page)).toHaveAttribute('aria-checked', 'mixed');
    // Changing the page or the sort clears the selection; nothing hidden stays selected.
    await next.click();
    await expect(selectedCount(page)).toHaveCount(0);
    await previous.click();
    await rows(page).nth(1).getByRole('checkbox').click();
    await rows(page).nth(4).getByRole('checkbox').click({ modifiers: ['Shift'] });

    await page.getByRole('button', { name: 'Add 4 to Shortlist' }).click();
    await expect(toast(page).last()).toContainText('Added 4 to Shortlist');
    await expect(nav(page, 'Shortlist')).toContainText('4');
    await expect(selectedCount(page)).toHaveCount(0);
    await expect(row(page, title(1)).getByLabel('In Shortlist')).toBeVisible();
    await rows(page).nth(0).getByRole('checkbox').click();
    await rows(page).nth(4).getByRole('checkbox').click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Add 5 to Shortlist' }).click();
    await expect(toast(page).last()).toContainText('Added 1 to Shortlist · 4 were already there');
    await expect(nav(page, 'Shortlist')).toContainText('5');

    // Review: J/K and arrows follow the page order, S adds, Esc closes, X selects.
    await row(page, title(6)).locator('.cell-company').click();
    await expect(detailTitle(page)).toHaveText(title(6));
    await page.keyboard.press('j');
    await expect(detailTitle(page)).toHaveText(title(7));
    await page.keyboard.press('ArrowDown');
    await expect(detailTitle(page)).toHaveText(title(8));
    await page.keyboard.press('k');
    await expect(detailTitle(page)).toHaveText(title(7));
    await page.keyboard.press('s');
    await expect(toast(page).last()).toContainText('Added 1 to Shortlist');
    await expect(view(page).locator('.detail').getByText('In Shortlist')).toBeVisible();
    await page.keyboard.press('x');
    await expect(selectedCount(page)).toHaveText('1 selected');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    await expect(detailTitle(page)).toHaveText(title(7));
    // Esc that closes a menu leaves the details open.
    await view(page).getByRole('button', { name: 'Select by condition' }).click();
    await expect(page.getByRole('menu', { name: 'Select by condition' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Select by condition' })).toHaveCount(0);
    await expect(view(page).getByRole('button', { name: 'Select by condition' })).toBeFocused();
    await expect(detailTitle(page)).toHaveText(title(7));
    await page.keyboard.press('Escape');
    await expect(view(page).locator('.detail')).toHaveCount(0);
    await rows(page).first().locator('.cell-company').click();
    await expect(view(page).getByRole('button', { name: 'Previous job' })).toBeDisabled();
    await page.screenshot({ path: path.join(dataDir, 'jobs-detail.png') });

    // A job that no longer matches after an action hands the details to the next one.
    await view(page).getByRole('button', { name: '+ Filter' }).click();
    await page.getByRole('menuitem', { name: 'In Shortlist' }).click();
    await page.getByRole('dialog', { name: 'In Shortlist filter' }).getByRole('radio', { name: 'Not in Shortlist' }).check();
    await page.getByRole('dialog', { name: 'In Shortlist filter' }).getByRole('button', { name: 'Apply' }).click();
    await expect(chips(page)).toHaveText(['Not in Shortlist']);
    await rows(page).nth(1).locator('.cell-company').click();
    const leaving = await detailTitle(page).textContent();
    const following = await rows(page).nth(2).locator('.cell-title').textContent();
    await page.keyboard.press('s');
    await expect(rows(page).filter({ hasText: leaving })).toHaveCount(0);
    await expect(detailTitle(page)).toHaveText(following);
    await view(page).getByRole('button', { name: 'Clear all' }).click();
    expect(page.errors).toEqual([]);
    await quit(application);

    // Sort and rows per page are remembered; the page number starts again at 1.
    ({ application, page } = await launch(dataDir));
    await expect(range(page)).toHaveText('1–100 of 125');
    await expect(header(page, 'Role')).toHaveAttribute('aria-sort', 'ascending');
  } finally { if (application.ownedProcess.exitCode === null) await application.close(); }
});

test('filters, search and Searches are per page, persist, and stale searches are dropped', async () => {
  const dataDir = await directory();
  await seed(dataDir, [import125, ['applications.add_many', { job_ids: [jobId(1), jobId(2), jobId(3)] }]]);
  let { application, page } = await launch(dataDir);
  try {
    const search = page.getByRole('searchbox', { name: 'Search jobs' });
    await search.fill('0007');
    await expect(chips(page)).toHaveText(['Search: 0007']);
    await expect(range(page)).toHaveText('1–1 of 1');
    await view(page).getByRole('button', { name: 'Clear all' }).click();
    await expect(chips(page)).toHaveCount(0);
    await expect(search).toHaveValue('');
    await expect(view(page).getByRole('button', { name: 'Clear all' })).toHaveCount(0);

    await view(page).getByRole('button', { name: '+ Filter' }).click();
    await page.getByRole('menuitem', { name: 'Score' }).click();
    const editor = page.getByRole('dialog', { name: 'Score filter' });
    await editor.getByLabel('Lowest score').fill('11');
    await editor.getByRole('button', { name: 'Apply' }).click();
    await expect(editor.getByRole('alert')).toHaveText('Scores are whole numbers from 0 to 10.');
    await editor.getByRole('button', { name: '8+' }).click();
    await editor.getByRole('button', { name: 'Apply' }).click();
    await expect(chips(page)).toHaveText(['Score ≥ 8']);
    const high = Array.from({ length: 125 }, (_, i) => fixture(i)).filter(job => job.score >= 8).length;
    await expect(range(page)).toHaveText(`1–${high} of ${high}`);
    await expect(rows(page).locator('.score').filter({ hasText: /^[0-7—]$/ })).toHaveCount(0);

    // Shortlist keeps its own filters.
    await nav(page, 'Shortlist').click();
    await expect(chips(page)).toHaveCount(0);
    await expect(range(page)).toHaveText('1–3 of 3');
    await nav(page, 'Jobs').click();
    await expect(chips(page)).toHaveText(['Score ≥ 8']);

    await page.locator('#sidebar').getByRole('button', { name: /^Data/ }).click();
    await expect(chips(page)).toHaveText(['Searches: Data', 'Score ≥ 8']);
    await expect(page.locator('.page-subtitle')).toContainText('Data · ');
    await expect(page.locator('#sidebar').getByRole('button', { name: /^Data/ })).toHaveAttribute('aria-current', 'true');
    await view(page).getByRole('button', { name: 'Remove filter: Score ≥ 8' }).click();
    await expect(range(page)).toHaveText('1–50 of 83');

    // No matches: different text from an empty library, with Clear filters.
    await search.fill('zzzz');
    await expect(view(page).getByText('No jobs match these filters')).toBeVisible();
    await expect(view(page).getByText('125 jobs are hidden by the current filters.')).toBeVisible();
    await view(page).getByRole('button', { name: 'Clear filters' }).click();
    await expect(range(page)).toHaveText('1–50 of 125');

    await search.fill('Engineer 00');
    await view(page).getByRole('button', { name: 'Next page' }).click();
    await expect(range(page)).toHaveText('51–100 of 100');
    await quit(application);

    ({ application, page } = await launch(dataDir));
    await expect(chips(page)).toHaveText(['Search: Engineer 00']);
    await expect(range(page)).toHaveText('1–50 of 100');

    // Collapsed rail: ⌘F pops out a focused search; Esc closes and keeps the keyword.
    await resize(application, 1000, 700);
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await page.keyboard.press('Meta+KeyF');
    const railSearch = page.getByRole('dialog', { name: 'Search' }).getByRole('searchbox');
    await expect(railSearch).toBeFocused();
    await railSearch.fill('0003');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
    await expect(chips(page)).toHaveText(['Search: 0003']);
    await expect(rows(page)).toHaveCount(1);
    await page.locator('#sidebar').getByRole('button', { name: 'Searches' }).hover();
    const searchesMenu = page.getByRole('menu', { name: 'Searches' });
    await expect(searchesMenu.getByRole('menuitemcheckbox', { name: /^Software/ })).toBeVisible();
    await searchesMenu.getByRole('menuitemcheckbox', { name: /^Software/ }).click();
    await expect(chips(page)).toHaveText(['Search: 0003', 'Searches: Software']);
    expect(await noPageOverflow(page)).toBe(true);
    await page.screenshot({ path: path.join(dataDir, 'rail-search.png') });
    await resize(application, 1280, 800);

    // Deleting a search (confirmation: Cancel focused, Esc cancels) drops filters that used it.
    await nav(page, 'Settings').click();
    const softwareRow = page.getByRole('row', { name: /Software/ });
    await softwareRow.getByRole('button', { name: 'Delete…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete search “Software”?' });
    await expect(confirm).toContainText('The 84 jobs stay in Jobs, and your Shortlist doesn\'t change.');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await softwareRow.getByRole('button', { name: 'Delete…' }).click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(toast(page).filter({ hasText: 'Deleted search “Software”' })).toBeVisible();
    await expect(toast(page).filter({ hasText: 'A filter for a search that no longer exists was removed.' })).toBeVisible();
    await nav(page, 'Jobs').click();
    await expect(chips(page)).toHaveText(['Search: 0003']);
    await expect(nav(page, 'Jobs')).toContainText('125');
    expect(page.errors).toEqual([]);
  } finally { if (application.ownedProcess.exitCode === null) await application.close(); }
});

test('Shortlist: status, notes, batch status and removal with Undo', async () => {
  const dataDir = await directory();
  const ids = [1, 2, 3, 4, 5, 6].map(jobId);
  await seed(dataDir, [
    import125,
    ['applications.add_many', { job_ids: ids }],
    ['applications.update', { job_id: jobId(1), status: 'applied', notes: 'Referral' }],
  ]);
  const { application, page } = await launch(dataDir);
  try {
    await nav(page, 'Shortlist').click();
    await expect(rows(page)).toHaveCount(6);
    await expect(row(page, title(1)).locator('.status-chip')).toHaveText('Applied');

    await row(page, title(2)).getByRole('button', { name: /^Status of/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Interviewing' }).click();
    await expect(row(page, title(2)).locator('.status-chip')).toHaveText('Interviewing');
    // Keyboard only: Return opens, arrows move, Return picks, focus returns to the chip.
    const chip4 = row(page, title(4)).getByRole('button', { name: /^Status of/ });
    await chip4.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitemcheckbox', { name: 'New' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(row(page, title(4)).locator('.status-chip')).toHaveText('OA');
    await expect(chip4).toBeFocused();
    // Status sorts in workflow order, not alphabetically.
    await header(page, 'Status').getByRole('button').click();
    await expect(rows(page).locator('.status-chip')).toHaveText(['New', 'New', 'New', 'Applied', 'OA', 'Interviewing']);

    // Notes in the table: double-click, Return saves, Esc discards.
    const tableNotes = view(page).locator('.notes-input');
    await row(page, title(3)).locator('.notes-cell').dblclick();
    await tableNotes.fill('Cover letter needed');
    await page.keyboard.press('Enter');
    await expect(row(page, title(3)).locator('.notes-cell')).toHaveText('Cover letter needed');
    await row(page, title(3)).locator('.notes-cell').dblclick();
    await tableNotes.fill('discard me');
    await page.keyboard.press('Escape');
    await expect(row(page, title(3)).locator('.notes-cell')).toHaveText('Cover letter needed');

    // Notes in details: ⌘↩ saves; Return on the current row opens the table editor.
    await row(page, title(5)).locator('.cell-company').click();
    const notes = view(page).locator('#detail-notes');
    await notes.fill('Phone screen Oct 21');
    await page.keyboard.press('Meta+Enter');
    await expect(view(page).getByText('Saved')).toBeVisible();
    await expect(row(page, title(5)).locator('.notes-cell')).toHaveText('Phone screen Oct 21');
    await notes.fill('not kept');
    await page.keyboard.press('Escape');
    await expect(notes).toHaveValue('Phone screen Oct 21');
    await page.keyboard.press('Escape');
    await expect(view(page).locator('.detail')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(tableNotes).toHaveValue('Phone screen Oct 21');
    await page.keyboard.press('Escape');

    // Batch status changes only status, and Undo (⌘Z) restores status and update time.
    for (const i of [1, 2, 3]) await row(page, title(i)).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Set status' }).click();
    await page.getByRole('menuitem', { name: 'Ghosted' }).click();
    await expect(toast(page).last()).toContainText('Status set to Ghosted for 3 jobs');
    for (const i of [1, 2, 3]) await expect(row(page, title(i)).locator('.status-chip')).toHaveText('Ghosted');
    await expect(row(page, title(1)).locator('.notes-cell')).toHaveText('Referral');
    await page.locator('.page-title').click();
    await page.keyboard.press('Meta+KeyZ');
    await expect(toast(page).last()).toContainText('Status change undone');
    await expect(row(page, title(1)).locator('.status-chip')).toHaveText('Applied');
    await expect(row(page, title(2)).locator('.status-chip')).toHaveText('Interviewing');
    await expect(row(page, title(3)).locator('.status-chip')).toHaveText('New');
    await expect(row(page, title(3)).locator('.notes-cell')).toHaveText('Cover letter needed');

    // Select by status replaces the selection.
    await view(page).getByRole('button', { name: 'Select by condition' }).click();
    await page.getByRole('menuitem', { name: 'Applied', exact: true }).click();
    await expect(view(page).locator('.selected-count')).toHaveText('1 selected');
    await expect(row(page, title(1)).getByRole('checkbox')).toBeChecked();

    // Remove has no confirmation; Undo restores status, notes and dates.
    const before = await page.evaluate(id => window.jobVaccum.getJobDetail({ job_id: id }), jobId(1));
    await row(page, title(2)).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Remove 2' }).click();
    await expect(toast(page).last()).toContainText('Removed 2 jobs from Shortlist');
    await expect(rows(page)).toHaveCount(4);
    await expect(nav(page, 'Shortlist')).toContainText('4');
    await toast(page).last().getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page).last()).toContainText('Restored 2 jobs to Shortlist');
    await expect(rows(page)).toHaveCount(6);
    const after = await page.evaluate(id => window.jobVaccum.getJobDetail({ job_id: id }), jobId(1));
    expect(after.result.application).toEqual(before.result.application);

    // Undo after cleanup removed the job reports it instead of pretending success.
    await row(page, title(6)).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Remove 1' }).click();
    await expect(toast(page).last()).toContainText('Removed 1 job from Shortlist');
    const removedToast = toast(page).last();
    const cleaned = await page.evaluate(() => window.jobVaccum.executeCleanup({ mode: 'manual' }));
    expect(cleaned.ok).toBe(true);
    await expect(view(page).getByText('Results updated')).toBeVisible();
    await removedToast.getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page).last()).toContainText("1 job was removed by cleanup and can't be restored.");
    await expect(toast(page).last()).toHaveClass(/toast-error/);
    await expect(rows(page)).toHaveCount(5);
    await page.screenshot({ path: path.join(dataDir, 'shortlist.png') });
    expect(page.errors).toEqual([]);
  } finally { await application.close(); }
});

test('export dialog, Settings Searches and Data', async () => {
  const dataDir = await directory();
  await seed(dataDir, [import125, ['applications.add_many', { job_ids: [jobId(1), jobId(2)] }]]);
  let { application, page } = await launch(dataDir);
  const csvPath = path.join(tempRoot, `M1 export ${path.basename(dataDir)}.csv`);
  try {
    await page.getByRole('searchbox', { name: 'Search jobs' }).fill('Engineer 000');
    await expect(range(page)).toHaveText('1–10 of 10');
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export jobs' });
    await expect(dialog.getByRole('radio', { name: /Current filter — 10 jobs/ })).toBeChecked();
    await expect(dialog.getByText('Search: Engineer 000 · all pages')).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /All jobs — 125/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /CSV|Markdown/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Export…' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Only the native save panel and Finder are stand-ins; the backend writes the file.
    await application.evaluate(({ dialog: native }) => { native.showSaveDialog = async () => ({ canceled: true }); });
    await page.getByRole('button', { name: 'Export' }).click();
    await dialog.getByRole('button', { name: 'Export…' }).click();
    await expect(dialog).toBeVisible();
    await application.evaluate(({ dialog: native, shell }, file) => {
      native.showSaveDialog = async () => ({ canceled: false, filePath: file });
      shell.showItemInFolder = target => { globalThis.shown = target; };
    }, csvPath);
    await dialog.getByRole('button', { name: 'Export…' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page).last()).toContainText('Exported 10 jobs');
    await toast(page).last().getByRole('button', { name: 'Show in Finder' }).click();
    await expect.poll(() => application.evaluate(() => globalThis.shown)).toBe(csvPath);
    const csv = await readFile(csvPath, 'utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.trim().split('\n')).toHaveLength(11);

    // Searches: Save needed, empty names refused, ⌥↓ reorders the sidebar.
    await nav(page, 'Settings').click();
    const software = page.getByRole('row', { name: /Software/ });
    await software.getByRole('button', { name: 'Rename' }).click();
    const name = page.getByRole('textbox', { name: 'Search name' });
    await name.fill('  ');
    await page.getByRole('table', { name: 'Searches' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a name.' })).toBeVisible();
    await name.fill('Platform');
    await page.keyboard.press('Enter');
    await expect(page.locator('.searches .search-item')).toHaveText([/^All searches/, /^Platform/, /^Data/]);
    await page.getByRole('button', { name: /^Move Platform/ }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator('.searches .search-item')).toHaveText([/^All searches/, /^Data/, /^Platform/]);
    await expect(page.getByRole('row', { name: /Platform/ })).toContainText('84 jobs');

    // Data: invalid days are explained and not saved; 0 turns automatic cleanup off.
    await page.locator('.settings-nav').getByRole('button', { name: 'Data' }).click();
    const days = page.getByLabel('Keep jobs for');
    await expect(days).toHaveValue('14');
    await expect(page.locator('.note-box')).toContainText('remove 0 jobs');
    await expect(page.locator('.note-box')).toContainText('2 Shortlist jobs are always kept.');
    await days.fill('-1');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a whole number of days, 0 or more.' })).toBeVisible();
    await days.fill('0');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.note-box')).toHaveText('Automatic cleanup is off. Jobs are kept until you clear them.');

    await page.getByRole('button', { name: 'Clear job data…' }).click();
    const clear = page.getByRole('dialog', { name: 'Clear job data?' });
    await expect(clear).toContainText('This deletes 123 jobs that aren\'t in your Shortlist');
    await expect(clear).toContainText('Your 2 Shortlist jobs (with details, status and notes) and settings are kept.');
    await expect(clear.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(clear).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear job data…' }).click();
    await clear.getByRole('button', { name: 'Clear job data' }).click();
    await expect(toast(page).last()).toContainText('Cleared 123 jobs');
    await expect(nav(page, 'Jobs')).toContainText('2');
    await quit(application);

    ({ application, page } = await launch(dataDir));
    await nav(page, 'Settings').click();
    await page.locator('.settings-nav').getByRole('button', { name: 'Data' }).click();
    await expect(page.getByLabel('Keep jobs for')).toHaveValue('0');
    expect(page.errors).toEqual([]);
  } finally { if (application.ownedProcess.exitCode === null) await application.close(); }
});

test('columns, horizontal scroll, narrow details and toast timing', async () => {
  test.setTimeout(150_000);
  const dataDir = await directory();
  await seed(dataDir, [import125]);
  let { application, page } = await launch(dataDir);
  try {
    await view(page).getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Why' }).click();
    await expect(header(page, 'Why')).toHaveCount(0);
    // Right-clicking the header opens the same menu.
    await header(page, 'Role').click({ button: 'right' });
    for (const name of ['Type', 'Source', 'Found']) {
      await page.getByRole('menuitemcheckbox', { name }).click();
      if (name !== 'Found') await view(page).getByRole('button', { name: 'Columns' }).click();
    }
    await expect(view(page).locator('thead th[scope="col"] .th-label')).toHaveText(['Score', 'Role', 'Company', 'Searches', 'Location', 'Type', 'Source', 'Posted', 'Found']);
    const handle = header(page, 'Role').locator('.col-resizer');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 3, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 83, box.y + 5, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => header(page, 'Role').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(320);
    await quit(application);

    ({ application, page } = await launch(dataDir));
    await expect(view(page).locator('thead th[scope="col"] .th-label')).toHaveText(['Score', 'Role', 'Company', 'Searches', 'Location', 'Type', 'Source', 'Posted', 'Found']);
    expect(await header(page, 'Role').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(320);
    // Shortlist keeps its own default columns.
    await nav(page, 'Shortlist').click();
    await expect(view(page).getByText('Your Shortlist is empty')).toBeVisible();
    await nav(page, 'Jobs').click();

    // Wider than the card: the table scrolls sideways, the window never does.
    await resize(application, 900, 700);
    expect(await view(page).locator('.table-scroll').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await noPageOverflow(page)).toBe(true);
    await rows(page).nth(2).locator('.cell-company').click();
    await expect(view(page).locator('.detail-overlay')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(view(page).locator('.detail-heading h2')).toHaveText(title(3));
    await page.screenshot({ path: path.join(dataDir, 'narrow-detail.png') });
    await page.keyboard.press('Escape');
    await expect(view(page).locator('.detail')).toHaveCount(0);
    await resize(application, 640, 480);
    expect(await noPageOverflow(page)).toBe(true);
    await page.screenshot({ path: path.join(dataDir, 'min-width.png') });
    await resize(application, 1280, 800);

    await view(page).getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('menuitem', { name: 'Reset columns' }).click();
    await expect(view(page).locator('thead th[scope="col"] .th-label')).toHaveText(['Score', 'Role', 'Company', 'Why', 'Searches', 'Location', 'Posted']);
    expect(await header(page, 'Role').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(240);

    // The details panel resizes from its left edge, never below 320 px, and the
    // same width is used docked and floating.
    await rows(page).nth(2).locator('.cell-company').click();
    const panel = view(page).locator('.detail');
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(360);
    const edge = await view(page).locator('.detail-resize').boundingBox();
    await page.mouse.move(edge.x + 3, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x - 97, edge.y + 200, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => panel.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(460);
    await resize(application, 1000, 700);
    await expect(view(page).locator('.detail-overlay')).toBeVisible();
    expect(await panel.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(460);
    await resize(application, 1280, 800);
    const edge2 = await view(page).locator('.detail-resize').boundingBox();
    await page.mouse.move(edge2.x + 3, edge2.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge2.x + 400, edge2.y + 200, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => panel.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(320);
    await view(page).locator('.detail-resize').dblclick();
    await expect.poll(() => panel.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(360);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // Toasts leave after about 8 seconds.
    await page.mouse.move(10, 400);
    await rows(page).nth(1).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Add 1 to Shortlist' }).click();
    const shown = Date.now();
    const plain = toast(page).last();
    await expect(plain).toContainText('Added 1 to Shortlist');
    await expect(plain).toHaveCount(0, { timeout: 11_000 });
    expect(Date.now() - shown).toBeGreaterThan(7000);
    // Hover and keyboard focus both hold a toast. Activity on the test Mac (the real cursor
    // crossing the window, switching apps) also sends pointer/blur events, so up to three
    // toasts are tried; one held for 9 seconds proves the hold.
    let heldOnce = false;
    for (let attempt = 2; attempt < 5 && !heldOnce; attempt += 1) {
      await rows(page).nth(attempt).getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Add 1 to Shortlist' }).click();
      const held = toast(page).last();
      await held.getByRole('button', { name: 'Dismiss' }).focus();
      await page.waitForTimeout(9000);
      heldOnce = await held.isVisible();
      await page.locator('#sidebar').getByRole('button', { name: /^Jobs/ }).focus();
      await expect(held).toHaveCount(0, { timeout: 10_000 });
    }
    expect(heldOnce).toBe(true);
    expect(page.errors).toEqual([]);
  } finally { if (application.ownedProcess.exitCode === null) await application.close(); }
});

test('request failures, skeleton rows, Markdown safety and external links', async () => {
  const dataDir = await directory();
  await seed(dataDir, [import125]);
  const { application, page } = await launch(dataDir);
  try {
    await application.evaluate(({ ipcMain, shell }) => {
      globalThis.opened = [];
      shell.openExternal = async url => { globalThis.opened.push(url); };
      globalThis.realList = ipcMain._invokeHandlers.get('jobs:list');
      ipcMain.removeHandler('jobs:list');
      ipcMain.handle('jobs:list', () => new Promise(resolve => setTimeout(() => resolve({
        ok: false, error: { code: 'TIMEOUT', message: "The backend didn't respond in time.", retryable: true },
      }), 2500)));
    });
    await view(page).getByRole('button', { name: 'Next page' }).click();
    // Skeleton rows only after ~0.5 s of waiting.
    await expect(view(page).locator('.skeleton-row').first()).toBeVisible();
    await page.screenshot({ path: path.join(dataDir, 'loading.png') });
    const banner = view(page).getByRole('alert');
    await expect(banner).toContainText("Couldn't load jobs. The backend didn't respond in time.");
    await expect(banner.locator('.error-code')).toHaveText('TIMEOUT');
    await page.screenshot({ path: path.join(dataDir, 'request-error.png') });
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('jobs:list');
      ipcMain.handle('jobs:list', globalThis.realList);
    });
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(banner).toHaveCount(0);
    await expect(range(page)).toHaveText('51–100 of 125');

    // JD Markdown: no raw HTML or scripts, unsafe links stay text, web links open in the browser.
    await application.evaluate(({ ipcMain }) => {
      const real = ipcMain._invokeHandlers.get('jobs:detail');
      ipcMain.removeHandler('jobs:detail');
      ipcMain.handle('jobs:detail', async (event, params) => {
        const response = await real(event, params);
        if (response.ok) response.result.description = '## About\n\n<script>window.hacked = 1</script>\n\n<img src=x onerror="window.hacked = 2">\n\n- **Build** things\n- [Apply here](https://example.invalid/apply) and [bad](javascript:alert(1))';
        return response;
      });
    });
    await rows(page).first().locator('.cell-company').click();
    const markdown = view(page).locator('.markdown');
    await expect(markdown.locator('h2')).toHaveText('About');
    await expect(markdown.locator('li strong')).toHaveText('Build');
    await expect(markdown).toContainText('<script>window.hacked = 1</script>');
    await expect(markdown.locator('script, img, iframe')).toHaveCount(0);
    await expect(markdown.locator('a')).toHaveCount(1);
    expect(await page.evaluate(() => window.hacked)).toBeUndefined();
    await markdown.getByRole('link', { name: 'Apply here' }).click();
    await page.keyboard.press('o');
    await expect.poll(() => application.evaluate(() => globalThis.opened)).toEqual([
      'https://example.invalid/apply', `https://example.invalid/linkedin/50`,
    ]);
    expect(await page.evaluate(() => window.jobVaccum.openLink('file:///etc/hosts').then(() => 'opened', () => 'refused'))).toBe('refused');
    await page.screenshot({ path: path.join(dataDir, 'markdown.png') });
    expect(page.errors).toEqual([]);
  } finally { await application.close(); }
});

const contrast = (page, pairs) => page.evaluate(list => {
  const rgb = color => {
    const probe = document.createElement('span');
    probe.style.color = color;
    document.body.append(probe);
    const parsed = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
    probe.remove();
    return parsed;
  };
  const luminance = ([r, g, b]) => [r, g, b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return list.map(([text, background]) => {
    const [a, b] = [luminance(rgb(css(text))), luminance(rgb(css(background)))];
    return { text, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  });
}, pairs);

test('main pages in each theme, light and dark, keep status and score colors readable', async () => {
  test.setTimeout(90_000);
  const dataDir = await directory();
  const statuses = ['new', 'applied', 'oa', 'interviewing', 'offer', 'rejected', 'ghosted'];
  await seed(dataDir, [
    import125,
    ['applications.add_many', { job_ids: statuses.map((_, i) => jobId(i + 1)) }],
    ...statuses.map((status, i) => ['applications.update', { job_id: jobId(i + 1), status, notes: i % 2 ? `Synthetic note ${i}` : '' }]),
  ], `UPDATE jobs SET score_state='failed', last_score_error='Synthetic model error' WHERE id IN ('${jobId(5)}','${jobId(14)}');
      UPDATE jobs SET score_state='pending' WHERE id='${jobId(8)}'; UPDATE jobs SET score_state='running', score=NULL WHERE id='${jobId(12)}';`);
  const { application, page } = await launch(dataDir);
  const shots = path.join(dataDir, 'themes');
  await mkdir(shots, { recursive: true });
  try {
    const applied = [];
    for (const scheme of ['light', 'dark']) {
      for (const theme of ['Graphite', 'Pine', 'Ink']) {
        await nav(page, 'Settings').click();
        await page.getByRole('button', { name: 'Appearance' }).click();
        await page.getByRole('radio', { name: scheme === 'light' ? 'Light' : 'Dark', exact: true }).check();
        await page.getByRole('radiogroup', { name: scheme === 'light' ? 'Light theme' : 'Dark theme' }).getByRole('radio', { name: theme }).check();
        await nav(page, 'Jobs').click();
        await expect(row(page, title(5)).locator('.score')).toHaveText('!');
        await expect(row(page, title(8)).locator('.score')).toHaveText('…');
        for (const i of [1, 2, 3]) await row(page, title(i)).getByRole('checkbox').check();
        await row(page, title(2)).locator('.cell-company').click();
        await page.screenshot({ path: path.join(shots, `${scheme}-${theme}-jobs.png`) });
        await view(page).getByRole('button', { name: 'Close details' }).click();
        await nav(page, 'Shortlist').click();
        await row(page, title(2)).getByRole('checkbox').check();
        await row(page, title(4)).locator('.cell-company').click();
        await page.screenshot({ path: path.join(shots, `${scheme}-${theme}-shortlist.png`) });
        applied.push(await row(page, title(2)).locator('.status-chip').evaluate(el => getComputedStyle(el).backgroundColor));
        const pairs = [['--text', '--card'], ['--text-secondary', '--card'], ['--text-secondary', '--sidebar'], ['--text', '--selected-row'],
          ['--text', '--nav-active'], ['--accent-text', '--accent'], ['--link', '--card'],
          ...statuses.map(status => [`--status-${status}-text`, `--status-${status}-bg`]),
          ...['high', 'mid', 'low', 'none', 'failed'].map(tone => [`--score-${tone}-text`, `--score-${tone}-bg`])];
        for (const result of await contrast(page, pairs)) {
          expect(result.ratio, `${scheme} ${theme}: ${result.text} on ${result.background}`).toBeGreaterThanOrEqual(4.5);
        }
        await view(page).getByRole('button', { name: 'Close details' }).click();
      }
    }
    // Status colors are shared by all three themes within a scheme.
    expect(new Set(applied.slice(0, 3)).size).toBe(1);
    expect(new Set(applied.slice(3)).size).toBe(1);
    expect(applied[0]).not.toBe(applied[3]);
    expect(page.errors).toEqual([]);
  } finally { await application.close(); }
});
