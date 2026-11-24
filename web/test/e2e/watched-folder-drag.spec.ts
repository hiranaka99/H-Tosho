import { expect, test, type Locator, type Page } from '@playwright/test';
import type { WatchedSearch, WatchedSearchFolder } from '../../../server/src/contracts/following';

let watchId: number | undefined;
let folderIds: number[] = [];

async function dragWatch(page: Page, handle: Locator, destination: Locator) {
  // Native mouse coordinates must be measured after the side sheet settles.
  await expect.poll(() => handle.evaluate(element => !element.closest('.sheet-content')?.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
  await handle.hover();
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.down();
  // Start the drag before scrolling a distant folder into view.
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 10, bounds!.y + bounds!.height / 2, { steps: 5 });
  await destination.hover();
  await destination.hover();
  await page.mouse.up();
}

async function currentWatch(page: Page): Promise<WatchedSearch> {
  const response = await page.request.get(`/api/watched-searches/${watchId}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.beforeEach(async ({ page }, testInfo) => {
  watchId = undefined;
  folderIds = [];
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  for (const name of ['Artists', 'Favorites']) {
    const response = await page.request.post('/api/watched-search-folders', { data: { name: `${name} ${testInfo.project.name}` } });
    expect(response.ok()).toBeTruthy();
    folderIds.push((await response.json() as WatchedSearchFolder).id);
  }
  const added = await page.request.post('/api/watched-searches', { data: { source: 'hitomi', query: `artist:folder-drag-${testInfo.project.name}` } });
  expect(added.ok()).toBeTruthy();
  watchId = (await added.json() as WatchedSearch).id;
  await page.goto('/downloader?tab=watched');
  await page.getByRole('button', { name: /^Manage watches/ }).click();
  await expect(page.locator(`[data-watched-search-id="${watchId}"]`)).toBeVisible();
});

test.afterEach(async ({ page }) => {
  if (watchId !== undefined) {
    const watch = await currentWatch(page);
    expect((await page.request.delete(`/api/watched-searches/${watch.id}`, { data: { expectedRevision: watch.revision } })).ok()).toBeTruthy();
  }
  const folders = await (await page.request.get('/api/watched-search-folders')).json() as WatchedSearchFolder[];
  for (const folder of folders.filter(item => folderIds.includes(item.id))) {
    expect((await page.request.delete(`/api/watched-search-folders/${folder.id}`, { data: { expectedRevision: folder.revision } })).ok()).toBeTruthy();
  }
});

test('dragging saves folder moves, ignores the current folder, and persists after reload', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Touch users use the folder selector covered below.');
  const row = page.locator(`[data-watched-search-id="${watchId}"]`);
  const handle = row.getByRole('button', { name: /^Move watch/ });
  const folder = (id: number | string) => page.locator(`[data-watch-folder-id="${id}"]`);
  const original = await currentWatch(page);
  await dragWatch(page, handle, folder(folderIds[0]));
  // Folder membership is shown by grouping, not repeated inside the row.
  await expect(page.locator(`[data-watch-folder-id="${folderIds[0]}"] [data-watched-search-id="${watchId}"]`)).toBeVisible();
  await expect(folder(folderIds[0]).locator(`[data-watched-search-id="${watchId}"]`)).toBeVisible();
  await expect(folder('unfiled').locator(`[data-watched-search-id="${watchId}"]`)).toHaveCount(0);
  await expect.poll(async () => (await currentWatch(page)).folderId).toBe(folderIds[0]);
  await expect(handle).toBeEnabled();
  const firstMove = await currentWatch(page);
  expect(firstMove).toMatchObject({ query: original.query, source: original.source, pausedAt: original.pausedAt, intervalMinutes: original.intervalMinutes, notificationMode: original.notificationMode });
  await folder(folderIds[0]).screenshot({ path: testInfo.outputPath('folder-group-desktop-light.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await folder(folderIds[0]).screenshot({ path: testInfo.outputPath('folder-group-desktop-dark.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  await dragWatch(page, handle, folder(folderIds[0]));
  expect((await currentWatch(page)).revision).toBe(firstMove.revision);
  await dragWatch(page, handle, folder(folderIds[1]));
  await expect(folder(folderIds[1]).locator(`[data-watched-search-id="${watchId}"]`)).toBeVisible();
  await expect(folder(folderIds[0]).locator(`[data-watched-search-id="${watchId}"]`)).toHaveCount(0);
  await expect(handle).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: /^Manage watches/ }).click();
  await expect(folder(folderIds[1]).locator(`[data-watched-search-id="${watchId}"]`)).toBeVisible();
  await dragWatch(page, handle, folder('unfiled'));
  await expect(folder('unfiled').locator(`[data-watched-search-id="${watchId}"]`)).toBeVisible();
  await expect.poll(async () => (await currentWatch(page)).folderId).toBeNull();
  await expect(handle).toBeEnabled();

  // Capture the same highlighted drop state at desktop and the supplied image width.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await handle.dispatchEvent('dragstart', { dataTransfer: transfer });
  await folder(folderIds[0]).dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(folder(folderIds[0])).toContainText('Release to move');
  await page.locator('main').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('folder-drop-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 2333, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('folder-drop-user-2333.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.getByRole('list', { name: 'Watch folders', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('folder-drop-desktop-dark-targets.png'), fullPage: true, animations: 'disabled' });
  await handle.dispatchEvent('dragend', { dataTransfer: transfer });
  await expect(folder(folderIds[0])).not.toContainText('Release to move');
  expect((await currentWatch(page)).folderId).toBeNull();
  await transfer.dispose();
});

test('failed and conflicting drops retain saved organization and recover for another move', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Native drag behavior is exercised on desktop.');
  const row = page.locator(`[data-watched-search-id="${watchId}"]`);
  const handle = row.getByRole('button', { name: /^Move watch/ });
  const destination = page.locator(`[data-watch-folder-id="${folderIds[0]}"]`);
  const endpoint = `**/api/watched-searches/${watchId}`;
  await page.route(endpoint, route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, json: { error: 'Move unavailable. Try again.' } }) : route.continue());
  await dragWatch(page, handle, destination);
  await expect(row.getByRole('alert')).toContainText('Move unavailable');
  expect((await currentWatch(page)).folderId).toBeNull();
  await page.unroute(endpoint);
  const beforeConflict = await currentWatch(page);
  expect((await page.request.patch(`/api/watched-searches/${watchId}`, { data: { expectedRevision: beforeConflict.revision, displayName: 'Updated elsewhere' } })).ok()).toBeTruthy();
  await dragWatch(page, handle, destination);
  await expect(row.getByRole('alert')).toContainText('changed elsewhere');
  await expect(row).toContainText('Updated elsewhere');
  expect((await currentWatch(page)).folderId).toBeNull();
  await expect(handle).toBeEnabled();
  await dragWatch(page, handle, destination);
  // Folder membership is shown by grouping, not repeated inside the row.
  await expect(page.locator(`[data-watch-folder-id="${folderIds[0]}"] [data-watched-search-id="${watchId}"]`)).toBeVisible();
  await expect(row.getByRole('alert')).toHaveCount(0);
});

test('the move handle opens a keyboard and touch accessible folder selector', async ({ page, isMobile }, testInfo) => {
  const row = page.locator(`[data-watched-search-id="${watchId}"]`);
  // Touch has no drag, so the grip is hidden there and Edit carries the folder choice.
  const handle = row.getByRole('button', isMobile ? { name: /^Edit watch/ } : { name: /^Move watch/ });
  if (isMobile) await handle.tap();
  else { await handle.focus(); await handle.press('Enter'); }
  const editor = row.getByRole('form');
  await editor.getByLabel('Folder', { exact: true }).selectOption(String(folderIds[0]));
  if (isMobile) {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await editor.scrollIntoViewIfNeeded();
    await editor.screenshot({ path: testInfo.outputPath('folder-move-mobile-dark-editor.png'), animations: 'disabled' });
  }
  await editor.getByRole('button', { name: 'Save watch', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(`[data-watch-folder-id="${folderIds[0]}"] [data-watched-search-id="${watchId}"]`)).toBeVisible();
  const group = page.locator(`[data-watch-folder-id="${folderIds[0]}"]`);
  await expect(group.locator(`[data-watched-search-id="${watchId}"]`)).toBeVisible();
  await expect(page.locator('[data-watch-folder-id="unfiled"]').locator(`[data-watched-search-id="${watchId}"]`)).toHaveCount(0);
  await expect(row).toContainText('Not checked yet');
  await expect(row).toContainText(/Every \d+ (min|hours?)/);
  expect((await currentWatch(page)).folderId).toBe(folderIds[0]);
  await expect(row.getByRole('button', { name: /^Edit watch/ })).toBeFocused();
  await expect(row.getByRole('button', { name: /^Check once/ })).toHaveCount(0);
  const actions = row.locator('[data-watch-actions]');
  const edit = actions.getByRole('button', { name: /^Edit watch/ });
  const pause = actions.getByRole('button', { name: /^Pause watch/ });
  await expect(edit).toHaveText('');
  await expect(edit).toHaveAttribute('title', 'Edit watch');
  await expect(pause).toHaveText('');
  await expect(pause).toHaveAttribute('title', 'Pause watch');
  const placement = await row.evaluate(element => ({
    top: element.getBoundingClientRect().top,
    actions: element.querySelector('[data-watch-actions]')!.getBoundingClientRect().top,
  }));
  expect(placement.actions - placement.top).toBeLessThan(20);
  await pause.focus();
  await pause.press('Enter');
  const resume = actions.getByRole('button', { name: /^Resume watch/ });
  await expect(resume).toHaveAttribute('aria-pressed', 'true');
  await expect(resume).toHaveAttribute('title', 'Resume watch');
  expect((await currentWatch(page)).pausedAt).not.toBeNull();
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'false');
  expect((await currentWatch(page)).pausedAt).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.evaluate(() => localStorage.setItem('h-tosho:theme', 'dark'));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await group.screenshot({ path: testInfo.outputPath(`folder-group-${testInfo.project.name}-dark.png`), animations: 'disabled' });
  await page.screenshot({ path: testInfo.outputPath(`folder-move-${testInfo.project.name}-row-dark.png`), fullPage: true, animations: 'disabled' });
  await page.locator('main').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath(`folder-move-${testInfo.project.name}-dark.png`), fullPage: true, animations: 'disabled' });
});
