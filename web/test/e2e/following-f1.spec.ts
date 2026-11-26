import { expect, test, type Page } from '@playwright/test';
import type { WatchedSearch, WatchedSearchFolder } from '../../../server/src/contracts/following';

let originalInterval: number | undefined;
let historyFolderRestore: { id: number; folderId: number | null } | undefined;
test.afterEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(30_000);
  if (originalInterval === undefined) return;
  const minutes = originalInterval;
  originalInterval = undefined;
  if (historyFolderRestore) {
    const original = historyFolderRestore;
    historyFolderRestore = undefined;
    const watches = await (await page.request.get('/api/watched-searches')).json() as WatchedSearch[];
    const current = watches.find(watch => watch.id === original.id);
    if (current) expect((await page.request.patch(`/api/watched-searches/${current.id}`, { data: { expectedRevision: current.revision, folderId: original.folderId } })).ok()).toBeTruthy();
  }
  await page.request.put('/api/settings/watched-search-interval', { data: { minutes } });
  const cleanup = await page.request.delete(`/api/__test/following/${testInfo.project.name}`);
  expect(cleanup.ok()).toBeTruthy();
});

async function watchByQuery(page: Page, query: string): Promise<WatchedSearch> {
  const response = await page.request.get('/api/watched-searches');
  expect(response.ok()).toBeTruthy();
  const watch = (await response.json() as WatchedSearch[]).find(item => item.query === query);
  expect(watch).toBeDefined();
  return watch!;
}

async function folders(page: Page): Promise<WatchedSearchFolder[]> {
  const response = await page.request.get('/api/watched-search-folders');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

// Seed check results through the API; individual manual checks are absent from Following.
async function runFixtureCheck(page: Page, query: string) {
  const watch = await watchByQuery(page, query);
  const response = await page.request.post('/api/watched-searches/check', { data: { watchIds: [watch.id] } });
  expect(response.status()).toBe(202);
  const { id } = await response.json();
  await expect.poll(async () => (await (await page.request.get(`/api/jobs/${id}`)).json()).job.status, { timeout: 15_000 }).toBe('completed');
  await page.reload();
  await page.getByRole('button', { name: /^Manage watches/ }).click();
  await expect(page.getByRole('dialog', { name: 'Manage watches' })).toBeVisible();
}

test('Following organizes watches, recovers revisions, checks paused watches and retains readable provenance', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const project = testInfo.project.name;
  const query = `artist:e2e-following-${project}`;
  const folderA = `F1 ${project} Artists`, folderB = `F1 ${project} Reading`, renamedFolder = `F1 ${project} Favorites`;
  const label = `Following artist ${project}`;
  const acquisitions: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && ['/api/downloads', '/api/downloads/merged'].includes(new URL(request.url()).pathname)) acquisitions.push(request.url());
  });
  // Catalog-independent Home/sidebar setup; F1 routes and Task execution are real.
  await page.route('**/api/recommendations', route => route.fulfill({ json: { date: '2026-11-16', generatedAt: '2026-11-16T00:00:00Z', mode: 'popular', profile: { artists: [], tags: [], series: [], language: null }, items: [], repeatedCount: 0, degradedReason: null, ownedKeys: [], dismissedKeys: [] } }));
  await page.route('**/api/downloads/library-matches', route => route.fulfill({ json: { reports: [], warnings: [] } }));
  await page.route('**/api/doujin/suggestions', route => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  originalInterval = (await (await page.request.get('/api/settings')).json()).watchedSearchIntervalMinutes;
    await page.request.put('/api/settings/watched-search-interval', { data: { minutes: 15 } });
    await page.goto('/downloader?tab=watched');
    const manage = page.getByRole('button', { name: /^Manage watches/ });
    // Watch upkeep lives in a modal side sheet, so inbox checks need it closed and row edits need it open.
    const manageSheet = page.locator('.sheet-content'); // Located by class: a nested confirm dialog hides the sheet from role queries.
    const closeManage = async () => { if (await manageSheet.count()) { await manageSheet.getByRole('button', { name: 'Close dialog', exact: true }).click(); await expect(manageSheet).toHaveCount(0); } };
    const openManage = async () => { if (!(await manageSheet.count())) { await manage.click(); await expect(manageSheet).toBeVisible(); } };
    await manage.focus();
    await manage.press('Enter');
    const newFolder = page.getByRole('form', { name: 'Add a watch folder' });
    const newFolderTrigger = page.getByRole('button', { name: 'New folder', exact: true });
    const folderHeader = page.getByRole('heading', { name: 'Folders', exact: true }).locator('..');
    await expect(newFolder).toHaveCount(0);
    await folderHeader.screenshot({ path: testInfo.outputPath('folder-create-collapsed-light.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await folderHeader.screenshot({ path: testInfo.outputPath('folder-create-collapsed-dark.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await newFolderTrigger.focus();
    await newFolderTrigger.press('Enter');
    await expect(newFolder.getByLabel('New folder name', { exact: true })).toBeFocused();
    await expect(newFolder.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await newFolder.getByLabel('New folder name', { exact: true }).fill('Discard this draft');
    await newFolder.getByLabel('New folder name', { exact: true }).press('Escape');
    await expect(newFolder).toHaveCount(0);
    await expect(newFolderTrigger).toBeFocused();
    let rejectFirstCreate = true;
    await page.route('**/api/watched-search-folders', route => {
      if (route.request().method() === 'POST' && rejectFirstCreate) {
        rejectFirstCreate = false;
        return route.fulfill({ status: 503, json: { error: 'Fixture folder save failed' } });
      }
      return route.continue();
    });
    for (const name of [folderA, folderB]) {
      await newFolderTrigger.click();
      await expect(newFolder.getByLabel('New folder name', { exact: true })).toHaveValue('');
      await newFolder.getByLabel('New folder name', { exact: true }).fill(name);
      if (name === folderA) {
        await folderHeader.screenshot({ path: testInfo.outputPath('folder-create-open-light.png'), animations: 'disabled' });
        await page.evaluate(() => document.documentElement.classList.add('dark'));
        await folderHeader.screenshot({ path: testInfo.outputPath('folder-create-open-dark.png'), animations: 'disabled' });
        await page.evaluate(() => document.documentElement.classList.remove('dark'));
        await newFolder.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('Fixture folder save failed');
        await expect(newFolder.getByLabel('New folder name', { exact: true })).toHaveValue(name);
      }
      await newFolder.getByLabel('New folder name', { exact: true }).press('Enter');
      await expect(newFolder).toHaveCount(0);
      await expect(newFolderTrigger).toBeFocused();
    }
    await page.unroute('**/api/watched-search-folders');
    await newFolderTrigger.click();
    await newFolder.getByRole('button', { name: 'Cancel new folder', exact: true }).click();
    await expect(newFolder).toHaveCount(0);
    await expect(newFolderTrigger).toBeFocused();
    await page.getByRole('button', { name: `Move folder ${folderB} up`, exact: true }).click();
    await expect.poll(async () => (await folders(page)).filter(folder => folder.name.startsWith(`F1 ${project} `)).map(folder => folder.name)).toEqual([folderB, folderA]);
    await page.getByRole('button', { name: `Rename folder ${folderB}`, exact: true }).click();
    const rename = page.getByRole('form', { name: `Rename folder ${folderB}`, exact: true });
    await rename.getByLabel('Folder name', { exact: true }).fill(renamedFolder);
    await rename.getByRole('button', { name: 'Save folder', exact: true }).click();
    await expect(page.getByRole('button', { name: `Rename folder ${renamedFolder}`, exact: true })).toBeVisible();

    const add = page.getByRole('form', { name: 'Add a watched search' });
    await add.getByRole('combobox', { name: 'Watched search query', exact: true }).fill(query);
    await add.getByRole('button', { name: 'Add watch', exact: true }).click();
    await expect(add.getByRole('combobox', { name: 'Watched search query', exact: true })).toHaveValue('');
    const initial = await watchByQuery(page, query);
    const row = page.locator(`[data-watched-search-id="${initial.id}"]`);
    await expect(row).toContainText('Every 15 min (default)');
    await expect(row.getByRole('button', { name: /^Check once/ })).toHaveCount(0);
    await row.getByRole('button', { name: `Edit watch ${query}`, exact: true }).click();
    let editor = row.getByRole('form');
    await editor.getByLabel('Watch name', { exact: true }).fill(label);
    await editor.getByLabel('Folder', { exact: true }).selectOption({ label: renamedFolder });
    await editor.getByLabel('Check interval', { exact: true }).selectOption('60');
    // Simulate another browser editing the same revision using the genuine API.
    const changed = await page.request.patch(`/api/watched-searches/${initial.id}`, { data: { expectedRevision: initial.revision, displayName: 'Changed in another browser' } });
    expect(changed.ok()).toBeTruthy();
    await editor.getByRole('button', { name: 'Save watch', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('This watch changed elsewhere');
    await expect(editor.getByLabel('Watch name', { exact: true })).toHaveValue(label);
    await expect(editor.getByRole('alert')).toContainText('Latest saved: Changed in another browser');
    await expect(editor.getByRole('button', { name: 'Save watch', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: 'Save watch', exact: true }).click();
    await expect(row.getByRole('form')).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Edit watch ${label}`, exact: true })).toBeFocused();
    await expect(row).toContainText(/Every 1 hour(?! \(default\))/);
    expect(await watchByQuery(page, query)).toMatchObject({ source: 'hitomi', query, displayName: label, intervalMinutes: 60 });
    const namedSearch = row.getByRole('button').filter({ hasText: label });
    await expect(namedSearch).toHaveAccessibleName(new RegExp(label));

    const saveGate = Promise.withResolvers<void>(), saveStarted = Promise.withResolvers<void>();
    const saveUrl = `**/api/watched-searches/${initial.id}`;
    await page.route(saveUrl, async route => {
      if (route.request().method() === 'PATCH') { saveStarted.resolve(); await saveGate.promise; }
      await route.continue();
    });
    try {
      await row.getByRole('button', { name: `Edit watch ${label}`, exact: true }).click();
      await row.getByRole('button', { name: 'Save watch', exact: true }).click();
      await saveStarted.promise;
      await page.getByRole('button', { name: 'Edit watch artist:history-test', exact: true }).click();
      const otherEditor = page.getByRole('form', { name: 'Edit watch artist:history-test', exact: true });
      await otherEditor.getByLabel('Watch name', { exact: true }).fill('Keep this second-watch draft');
      const watchRefresh = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/watched-searches');
      const feedRefresh = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/watched-searches/feed');
      saveGate.resolve();
      await Promise.all([watchRefresh, feedRefresh]);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(otherEditor).toBeVisible();
      await expect(otherEditor.getByLabel('Watch name', { exact: true })).toHaveValue('Keep this second-watch draft');
      await page.screenshot({ path: testInfo.outputPath('following-f1-late-save-draft.png'), animations: 'disabled' });
      await otherEditor.getByRole('button', { name: 'Cancel edit', exact: true }).click();
    } finally { saveGate.resolve(); await page.unroute(saveUrl); }

    await runFixtureCheck(page, query); // Silent seed.
    await expect(row).not.toContainText('Not checked yet');
    expect((await watchByQuery(page, query)).lastNewCount).toBe(0);
    await runFixtureCheck(page, query); // Deterministic provider failure.
    await expect(row).toContainText('Fixture provider unavailable');
    const failed = await watchByQuery(page, query);
    expect(failed.lastFailedAt).not.toBeNull();
    expect(failed.lastCheckedAt).not.toBeNull();
    await runFixtureCheck(page, query); // Recovery keeps failure provenance.
    await expect(row).not.toContainText('Fixture provider unavailable');
    expect(await watchByQuery(page, query)).toMatchObject({ lastFailedAt: failed.lastFailedAt, lastError: null, lastNewCount: 1 });

    await closeManage();
    const folderFilter = page.getByLabel('Filter discoveries by folder', { exact: true });
    await folderFilter.selectOption({ label: renamedFolder });
    await expect(page.getByRole('button', { name: new RegExp(`via ${label}`) })).toBeVisible();
    const favorite = (await folders(page)).find(folder => folder.name === renamedFolder)!;
    const historyWatch = await watchByQuery(page, 'artist:history-test');
    historyFolderRestore = { id: historyWatch.id, folderId: historyWatch.folderId };
    expect((await page.request.patch(`/api/watched-searches/${historyWatch.id}`, { data: { expectedRevision: historyWatch.revision, folderId: favorite.id } })).ok()).toBeTruthy();
    const watchFilter = page.getByLabel('Filter discoveries by watch', { exact: true });
    await watchFilter.selectOption(String(initial.id));
    await openManage();
    await row.getByRole('button', { name: `Edit watch ${label}`, exact: true }).click();
    await row.getByLabel('Folder', { exact: true }).selectOption({ label: folderA });
    await row.getByRole('button', { name: 'Save watch', exact: true }).click();
    await closeManage();
    await expect(page.getByRole('button', { name: 'View details for History gallery 12', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View details for Following fixture gallery 1', exact: true })).toHaveCount(0);
    await expect(watchFilter).toHaveValue('');
    await page.screenshot({ path: testInfo.outputPath('following-f1-filter-reset.png'), animations: 'disabled' });
    await openManage();
    await row.getByRole('button', { name: `Edit watch ${label}`, exact: true }).click();
    await row.getByLabel('Folder', { exact: true }).selectOption({ label: renamedFolder });
    await row.getByRole('button', { name: 'Save watch', exact: true }).click();
    await closeManage();
    await folderFilter.selectOption({ label: folderA });
    await expect(page.getByText('No matching finds', { exact: true })).toBeVisible();
    await folderFilter.selectOption({ label: renamedFolder });
    await openManage();
    await row.getByRole('button', { name: `Pause watch ${label}`, exact: true }).click();
    await expect(row).toContainText('Not checked while paused');
    await expect(row.getByRole('button', { name: /^Check once/ })).toHaveCount(0);
    await runFixtureCheck(page, query);
    expect(await watchByQuery(page, query)).toMatchObject({ effectiveIntervalMinutes: 0, nextCheckAt: null, lastNewCount: 1 });
    expect((await watchByQuery(page, query)).pausedAt).not.toBeNull();
    await closeManage();
    await expect(page.getByRole('button', { name: 'View details for Following fixture gallery 2', exact: true })).toBeVisible();
    await openManage();
    await row.getByRole('button', { name: `Resume watch ${label}`, exact: true }).click();
    await expect(row).toContainText(/Every 1 hour(?! \(default\))/);
    expect((await watchByQuery(page, query)).nextCheckAt).not.toBeNull();
    await page.getByLabel('Watched search check interval', { exact: true }).selectOption('0');
    await expect(row).toContainText('Automatic checks off');
    await page.getByLabel('Watched search check interval', { exact: true }).selectOption('15');
    await expect(row).toContainText(/Every 1 hour(?! \(default\))/);
    await row.getByRole('button', { name: `Edit watch ${label}`, exact: true }).click();
    editor = row.getByRole('form');
    await editor.getByLabel('Watch name', { exact: true }).fill('');
    await editor.getByLabel('Check interval', { exact: true }).selectOption('');
    await editor.getByRole('button', { name: 'Save watch', exact: true }).click();
    await expect(row.getByRole('button', { name: `Edit watch ${query}`, exact: true })).toBeVisible();
    await expect(row).toContainText('Every 15 min (default)');
    await row.getByRole('button', { name: `Edit watch ${query}`, exact: true }).click();
    await row.getByLabel('Watch name', { exact: true }).fill(label);
    await row.getByRole('button', { name: 'Save watch', exact: true }).click();
    await expect(row.getByRole('form')).toHaveCount(0);

    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await row.scrollIntoViewIfNeeded();
      expect(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      for (const control of [row.getByRole('button', { name: `Edit watch ${label}`, exact: true }), row.getByRole('button', { name: `Pause watch ${label}`, exact: true }), folderFilter]) {
        // Chromium's transformed bounds can contain float noise below one thousandth of a CSS pixel.
        const height = (await control.boundingBox())!.height;
        expect(Math.round(height * 1000) / 1000).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: testInfo.outputPath(`following-f1-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.getByRole('button', { name: `Delete folder ${renamedFolder}`, exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: /Delete folder|Remove watched search/ }).last();
    await expect(dialog).toContainText('Its watches move to Unfiled');
    await dialog.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await watchByQuery(page, query)).folderId).toBeNull();
    await closeManage();
    await folderFilter.selectOption('unfiled');
    await page.getByLabel('Filter discoveries by watch', { exact: true }).selectOption(String(initial.id));
    await expect(page.getByRole('button', { name: new RegExp(`via ${label}`) })).toHaveCount(2);
    await openManage();
    await row.getByRole('button', { name: `Remove watch ${label}`, exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row).toHaveCount(0);
    await closeManage();
    await expect(page.getByRole('button', { name: new RegExp(`via ${label} · removed watch`) })).toHaveCount(2);
    await page.getByRole('button', { name: 'Dismiss Following fixture gallery 2', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View details for Following fixture gallery 2', exact: true })).toHaveCount(0);
    await page.getByRole('radio', { name: /^All finds \(/ }).click();
    await expect(page.getByRole('button', { name: 'View details for Following fixture gallery 2', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`via ${label} · removed watch`) })).toHaveCount(2);
    await page.reload();
    await folderFilter.selectOption('unfiled');
    await page.getByLabel('Filter discoveries by watch', { exact: true }).selectOption(String(initial.id));
    await page.getByRole('radio', { name: /^All finds \(/ }).click();
    await expect(page.getByRole('button', { name: new RegExp(`via ${label} · removed watch`) })).toHaveCount(2);
    expect(acquisitions).toEqual([]);
    expect(errors).toEqual([]);
});
