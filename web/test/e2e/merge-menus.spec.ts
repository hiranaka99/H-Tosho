import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const gallery = { source: 'hitomi', galleryId: 'menu-sample', title: 'Garden Stories 02', artists: ['Sample Artist'], tags: [], pageCount: 24 };

async function capture(page: Page, testInfo: TestInfo, menu: string) {
  const directory = path.resolve('.impeccable/review');
  fs.mkdirSync(directory, { recursive: true });
  await page.locator('main').evaluate(element => { element.scrollTop = 0; });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await page.screenshot({ path: path.join(directory, `${menu}-${testInfo.project.name}-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/kavita/status', route => route.fulfill({ json: { configured: true, hasApiKey: true } }));
  await page.route('**/api/kavita/libraries', route => route.fulfill({ json: [{ id: 7, name: 'Collection', seriesCount: 2 }] }));
  await page.route('**/api/kavita/libraries/7/series', route => route.fulfill({ json: [
    { id: 50, name: 'Garden Stories 01', status: 'unmatched', artists: ['Sample Artist'], bookCount: 1 },
    { id: 51, name: 'Seasonal Stories', status: 'unmatched', artists: ['Sample Artist'], bookCount: 1 },
  ] }));
  await page.route('**/api/settings/downloader', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), downloadDirectory: '/library/downloads', format: 'cbz' } });
  });
  await page.route('**/api/cbz/roots', route => route.fulfill({ json: { roots: ['/library/downloads'] } }));
  await page.route('**/api/cbz/series/*', route => {
    const id = Number(route.request().url().split('/').pop());
    const file = `/library/${id}/Chapter ${id === 50 ? '01' : '02'}.cbz`;
    return route.fulfill({ json: { seriesId: id, dir: `/library/${id}`, reason: null, files: [file], chapterNumbers: { [file]: id === 50 ? '1' : '2' } } });
  });
  await page.route('**/api/doujin/search', route => route.fulfill({ json: { items: [gallery], total: 1 } }));
  await page.route('**/api/downloads/library-matches', route => route.fulfill({ json: { items: [], incomplete: false, errors: [] } }));
  await page.route('**/api/downloads/gallery-files?**', route => route.fulfill({ json: { files: [] } }));
  await page.route('**/api/downloads/duplicates', route => route.fulfill({ json: { reports: [], warnings: [] } }));
  await page.route('**/api/recommendations', route => route.fulfill({ json: {
    date: '2026-10-29', generatedAt: '2026-10-29T10:00:00Z', mode: 'popular',
    profile: { artists: [], tags: [], series: [], language: null }, items: [{ ...gallery, reasons: [] }],
    ownedKeys: [], dismissedKeys: [], repeatedCount: 0, degradedReason: null,
  } }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('library merges apply the chosen name independently of a custom folder', async ({ page }, testInfo) => {
  await page.goto('/libraries/7');
  await page.getByRole('button', { name: 'Select to merge', exact: true }).click();
  await page.getByRole('button', { name: 'Select Garden Stories 01', exact: true }).click();
  await page.getByRole('button', { name: 'Select Seasonal Stories', exact: true }).click();
  await page.getByRole('region', { name: 'Series selection', exact: true }).getByRole('button', { name: /^Merge/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge series', exact: true });
  const name = dialog.getByLabel('Merged series name', { exact: true });
  const queue = dialog.getByRole('button', { name: 'Queue merge', exact: true });
  await expect(name).toHaveValue('Garden Stories 01');
  await name.fill(' ');
  await expect(queue).toBeDisabled();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a series name.');
  await name.fill('Garden: Collected / Stories');
  await expect(dialog.getByLabel('Target folder', { exact: true })).toHaveAttribute('placeholder', '/library/downloads/Garden Collected Stories');
  await dialog.getByLabel('Target folder', { exact: true }).fill('/library/Custom folder');
  await expect(queue).toBeEnabled();
  await capture(page, testInfo, 'library-merge-name');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let submission: Record<string, unknown> | undefined;
  await page.route('**/api/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    submission = route.request().postDataJSON();
    await pending;
    return route.fulfill({ json: { id: 9100 } });
  });
  try {
    await queue.click();
    await expect(name).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally { finish(); }
  await expect(dialog).toHaveCount(0);
  expect(submission).toMatchObject({ type: 'merge-series', seriesName: 'Garden: Collected / Stories', targetDir: '/library/Custom folder', sourceFiles: ['/library/50/Chapter 01.cbz', '/library/51/Chapter 02.cbz'] });
});

for (const tab of ['search', 'recommend']) {
  async function selectGallery(page: Page) {
    await page.goto(tab === 'search' ? '/downloader?tab=search&q=garden' : '/downloader?tab=recommend');
    await page.getByRole('button', { name: 'Select galleries', exact: true }).click();
    await page.getByRole('button', { name: 'Select Garden Stories 02', exact: true }).click();
  }

  test(`${tab} supports optional rename when adding to an existing series`, async ({ page }, testInfo) => {
    await selectGallery(page);
    if (tab === 'recommend') await capture(page, testInfo, 'recommended-merge-selection');
    await page.getByRole('button', { name: 'Add to existing series', exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge into series', exact: true });
    await dialog.getByRole('button', { name: 'Select Garden Stories 01 as merge target', exact: true }).click();
    await dialog.getByRole('switch', { name: 'Rename series', exact: true }).click();
    await dialog.getByLabel('New series name', { exact: true }).fill('Garden Collection');
    let submission: Record<string, unknown> | undefined;
    await page.route('**/api/jobs', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      submission = route.request().postDataJSON();
      return route.fulfill({ json: { id: 9101 } });
    });
    await dialog.getByRole('button', { name: 'Queue merge (1 gallery)', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(submission).toMatchObject({ type: 'merge-series', seriesId: 50, seriesName: 'Garden Collection', downloads: [{ galleryId: gallery.galleryId, chapter: '2' }] });
  });

  test(`${tab} can choose the name for a newly merged download`, async ({ page }, testInfo) => {
    await selectGallery(page);
    await page.getByRole('button', { name: 'Download as new series', exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Merged download', exact: true });
    const name = dialog.getByLabel('Merged series name', { exact: true });
    await expect(name).toHaveValue(gallery.title);
    await name.fill('Garden Collection');
    if (tab === 'search') await capture(page, testInfo, 'new-merge-name');
    let submission: Record<string, unknown> | undefined;
    await page.route('**/api/downloads', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      submission = route.request().postDataJSON();
      return route.fulfill({ json: { id: 9102, status: 'queued' } });
    });
    await dialog.getByRole('button', { name: 'Download 1 gallery', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(submission).toMatchObject({ mergeFolder: 'Garden Collection', galleryId: gallery.galleryId, chapter: 1 });
  });
}
