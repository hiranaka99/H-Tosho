import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/settings/downloader', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), downloadDirectory: '/library/downloads' } });
  });
  await page.route('**/api/downloads/gallery-files?**', route => route.fulfill({ json: { files: [] } }));
  await page.route('**/api/downloads/library-matches', route => route.fulfill({ json: { reports: [], warnings: [] } }));
  await page.route('**/api/downloads/duplicates', route => route.fulfill({ json: { reports: [], warnings: [] } }));
  await page.route('**/api/kavita/libraries', route => route.fulfill({ json: [{ id: 7, name: 'Collection' }] }));
  await page.route('**/api/kavita/libraries/7/series', route => route.fulfill({ json: [
    { id: 50, name: 'Garden Stories 01', artists: ['Sample Artist'] },
    { id: 51, name: 'Seasonal Stories', artists: ['Sample Artist'] },
  ] }));
  await page.route('**/api/cbz/series/*', route => {
    const id = Number(route.request().url().split('/').pop());
    return route.fulfill({ json: { seriesId: id, dir: `/library/${id}`, reason: null, files: [`/library/${id}/Chapter 01.cbz`], chapterNumbers: { [`/library/${id}/Chapter 01.cbz`]: '1' } } });
  });
  await page.route('**/api/watched-searches/feed?**', route => route.fulfill({ json: {
    items: [{ source: 'hitomi', galleryId: 'sample-02', title: 'Garden Stories 02', artists: ['Sample Artist'], searchId: 1, query: 'artist:sample', foundAt: '2026-10-29T10:00:00Z', reviewedAt: null }],
    total: 1, inboxCount: 1, historyCount: 0, watches: [],
  } }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.goto('/downloader?tab=watched');
  await page.getByRole('button', { name: 'Select galleries', exact: true }).click();
  await page.getByRole('button', { name: 'Select Garden Stories 02', exact: true }).click();
  await page.getByRole('button', { name: 'Add to existing series', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Select Garden Stories 01 as merge target', exact: true }).click();
});

test('Watched can rename with a queued merge and preserve drafts after an error', async ({ page }, testInfo) => {
  const dialog = page.getByRole('dialog', { name: 'Merge into series' });
  const queue = dialog.getByRole('button', { name: 'Queue merge (1 gallery)', exact: true });
  await expect(queue).toBeEnabled();
  await expect(dialog.getByLabel('New series name', { exact: true })).toHaveCount(0);
  await dialog.getByRole('switch', { name: 'Rename series', exact: true }).click();
  const name = dialog.getByLabel('New series name', { exact: true });
  await expect(name).toHaveValue('Garden Stories 01');
  await name.fill(' ');
  await expect(queue).toBeDisabled();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a series name, or turn off Rename series.');
  await name.fill('Garden Stories — Collected Chapters');
  await dialog.getByRole('textbox', { name: 'Chapter number for Chapter 01.cbz', exact: true }).fill('1.5');
  await expect(queue).toBeEnabled();
  await expect(dialog.getByText('Rename on merge:', { exact: false })).toContainText('Garden Stories — Collected Chapters');
  const captures = path.resolve('.impeccable/review');
  fs.mkdirSync(captures, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await name.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(captures, `merge-${testInfo.project.name}-${theme}.png`), fullPage: true, animations: 'disabled' });
    await dialog.locator('div.overflow-y-auto').first().evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(captures, `merge-${testInfo.project.name}-${theme}-top.png`), fullPage: true, animations: 'disabled' });
  }
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    submissions.push(route.request().postDataJSON());
    return route.fulfill(submissions.length === 1 ? { status: 500, json: { error: 'Try again' } } : { json: { id: 9001 } });
  });
  await queue.click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not queue the merge. Drafts kept; try again.');
  await expect(name).toHaveValue('Garden Stories — Collected Chapters');
  await queue.click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toMatchObject({ type: 'merge-series', seriesId: 50, seriesName: 'Garden Stories — Collected Chapters', existingChapters: { '/library/50/Chapter 01.cbz': '1.5' }, downloads: [{ galleryId: 'sample-02', chapter: '2' }] });
});

test('changing targets resets rename drafts and leaving rename off keeps the existing name', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: 'Merge into series' });
  await dialog.getByRole('switch', { name: 'Rename series', exact: true }).click();
  await dialog.getByLabel('New series name', { exact: true }).fill('Temporary draft');
  await dialog.getByRole('button', { name: 'Select Seasonal Stories as merge target', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: 'Rename series', exact: true })).not.toBeChecked();
  await dialog.getByRole('switch', { name: 'Rename series', exact: true }).click();
  await expect(dialog.getByLabel('New series name', { exact: true })).toHaveValue('Seasonal Stories');
  await dialog.getByLabel('New series name', { exact: true }).fill('Ignored draft');
  await dialog.getByRole('switch', { name: 'Rename series', exact: true }).click();
  let submission: Record<string, unknown> | undefined;
  await page.route('**/api/jobs', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    submission = route.request().postDataJSON();
    return route.fulfill({ json: { id: 9002 } });
  });
  await dialog.getByRole('button', { name: 'Queue merge (1 gallery)', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(submission?.seriesId).toBe(51);
  expect(submission).not.toHaveProperty('seriesName');
});
