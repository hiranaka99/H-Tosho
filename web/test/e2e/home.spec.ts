import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const titles = ['After the rain', 'An evening in June', 'The long way home', 'Summer sketches', 'A quiet afternoon', 'Letters from the coast'];
const items = titles.map((title, index) => ({ source: 'hitomi', galleryId: String(100 + index), title, artists: ['Sample Artist'], tags: [], language: 'English', pageCount: 24 + index * 4, reasons: ['Artist in your library'], coverUrl: `/test-cover/${index}` }));
const recommendationSet = { date: '2026-11-15', generatedAt: '2026-11-15T09:00:00Z', mode: 'library', profile: { artists: [], tags: [], series: [], language: 'English' }, items, repeatedCount: 0, degradedReason: null, ownedKeys: [], dismissedKeys: [] };
const match = { seriesId: 11, name: 'Summer anthology', libraryId: 7, libraryName: 'Doujinshi', cover: '/test-cover/2', checkedAt: '2026-11-15T09:00:00Z', candidate: { providerId: 'anilist', providerSeriesId: 'new-candidate', title: 'Summer anthology', type: 'MANGA', score: 0.98 } };
const discoveries = ['A new chapter', 'Collected sketches', 'Weekend stories', 'Late summer'].map((title, index) => ({ source: 'hitomi', galleryId: String(200 + index), title, artists: ['Another Artist'], language: 'English', pageCount: 32, coverUrl: `/test-cover/${index + 1}`, query: 'artist:another_artist', foundAt: '2026-11-15T09:00:00Z', searchId: 1, reviewedAt: null }));

async function navigate(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/recommendations', route => route.fulfill({ json: recommendationSet }));
  await page.route('**/api/downloads/library-matches', route => route.fulfill({ json: { reports: [], warnings: [] } }));
  await page.route('**/api/settings/downloader', route => route.fulfill({ json: { downloadDirectory: 'C:/Downloads', format: 'cbz' } }));
  await page.route('**/api/kavita/status', route => route.fulfill({ json: { configured: true, version: '0.9.0' } }));
  await page.route('**/api/home/matches', route => route.fulfill({ json: { items: [match, { ...match, seriesId: 12, name: 'Evening collection', candidate: { ...match.candidate, title: 'Evening collection', score: 0.89 } }], configured: true, scan: { id: 1, status: 'completed', finishedAt: '2026-11-15T09:00:00Z', result: { processed: 32, matchable: 2, failed: 0 } } } }));
  await page.route('**/api/watched-searches/feed?*', route => route.fulfill({ json: { items: discoveries, total: 8, inboxCount: 8, historyCount: 12, watches: [] } }));
  await page.route('**/api/home/activity', route => route.fulfill({ json: [
    { id: 'a', title: 'Winter stories', action: 'downloaded', createdAt: '2026-11-15T08:50:00Z', href: '/downloader?tab=downloads' },
    { id: 'b', title: 'Summer anthology', action: 'matched', createdAt: '2026-11-15T08:40:00Z', href: '/libraries?series=11' },
    { id: 'c', title: 'Collected chapters', action: 'updated', createdAt: '2026-11-15T08:30:00Z', href: '/libraries?series=12' },
  ] }));
  await page.route('**/test-cover/*', route => {
    const index = Number(route.request().url().split('/').pop()) % 6;
    const colors = ['#48655c', '#8e5066', '#3e5768', '#bd8754', '#6b6685', '#7c8e73'];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="${colors[index]}"/><circle cx="235" cy="112" r="92" fill="#fff5df" opacity=".25"/><path d="M0 300 L180 160 L300 290 L300 400 L0 400Z" fill="#182b29" opacity=".3"/><text x="24" y="310" fill="#fff5df" font-family="Georgia" font-size="25">${titles[index].split(' ').slice(0, 3).join(' ')}</text><text x="24" y="346" fill="#fff5df" font-family="sans-serif" font-size="12">SAMPLE COVER · ${index + 1}</text></svg>`;
    return route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('Home is first in navigation, shows four live sections, and shares recommendations with Downloader', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link').first()).toHaveText('Home');
  if (await page.getByRole('button', { name: 'Close navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  for (const name of ['Recommended galleries', 'Galleries that can be matched', 'Unreviewed saved search results', 'Recent activity']) await expect(page.getByRole('heading', { name, exact: false })).toBeVisible();
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View all picks' }).click();
  await expect(page.getByRole('tab', { name: 'Recommended', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  await navigate(page, 'Home');
  await page.reload();
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('No match found persists the displayed candidate identity; reviewed finds leave the inbox', async ({ page }) => {
  let rejected = false, reviewed = false;
  await page.route('**/api/home/matches', route => route.fulfill({ json: { items: rejected ? [] : [match], configured: true, scan: null } }));
  await page.route('**/api/home/matches/11/reject', async route => {
    expect(route.request().postDataJSON()).toEqual({ providerId: 'anilist', providerSeriesId: 'new-candidate' });
    rejected = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/watched-searches/feed?*', route => route.fulfill({ json: { items: reviewed ? [] : [discoveries[0]], total: reviewed ? 0 : 1, inboxCount: reviewed ? 0 : 1, historyCount: 1, watches: [] } }));
  await page.route('**/api/watched-searches/review', async route => {
    expect(route.request().postDataJSON()).toEqual({ items: [{ source: 'hitomi', galleryId: '200' }], reviewed: true });
    reviewed = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'No match found', exact: true }).click();
  await expect(page.getByText('No matching candidates yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(page.getByText('Your inbox is clear', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('No matching candidates yet', { exact: true })).toBeVisible();
  await expect(page.getByText('Your inbox is clear', { exact: true })).toBeVisible();
});

test('review opens the discovered candidate directly and previews gallery details on Home', async ({ page }) => {
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: { id: 11, libraryId: 7, name: 'Summer anthology' }, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { providerId: 'anilist', providerSeriesId: 'new-candidate', title: 'Summer anthology', titleOptions: ['Summer anthology'], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Proposed summary', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.route('**/api/doujin/gallery', route => route.fulfill({ json: { ...items[0], url: 'https://hitomi.la/galleries/100.html', tags: [], previewPages: [] } }));
  await page.getByRole('button', { name: 'View details for After the rain', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'After the rain', exact: true })).toBeVisible();
});

test('responsive visual review in light and dark themes', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('main img').first()).toBeVisible();
  await page.locator('main img').evaluateAll(images => {
    // Off-screen and responsive-hidden covers still need loading for captures.
    images.forEach(image => { (image as HTMLImageElement).loading = 'eager'; });
    return Promise.all(images.map(image => (image as HTMLImageElement).decode().catch(() => {})));
  });
  const output = path.resolve('.impeccable/review');
  fs.mkdirSync(output, { recursive: true });
  const name = testInfo.project.name;
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const overflow = await page.evaluate(() => [...document.querySelectorAll('main, main *')].filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
  }).map(element => element.tagName + '.' + element.className).slice(0, 8));
  expect(overflow).toEqual([]);
  await page.evaluate(() => { document.documentElement.classList.add('dark'); document.querySelector('main')?.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(output, `${name}-dark.png`), fullPage: true });
  await page.locator('section[aria-labelledby="home-matches"]').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(output, `${name}-queues-dark.png`), fullPage: true });
  await page.locator('section[aria-labelledby="home-activity"]').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(output, `${name}-activity-dark.png`), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.screenshot({ path: path.join(output, `${name}-activity.png`), fullPage: true });
  await page.locator('section[aria-labelledby="home-matches"]').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(output, `${name}-queues.png`), fullPage: true });
});

test('scan and download actions use the background queues; one section failure leaves others usable', async ({ page }) => {
  let scans = 0, downloads = 0;
  await page.route('**/api/home/matches/scan', async route => { scans++; await route.fulfill({ status: 202, json: { id: 21, alreadyRunning: false } }); });
  await page.route('**/api/downloads/duplicates', route => route.fulfill({ json: { reports: [], warnings: [] } }));
  await page.route('**/api/downloads', async route => {
    if (route.request().method() === 'POST') { downloads++; await route.fulfill({ json: { id: 10, status: 'queued' } }); }
    else await route.fulfill({ json: [] });
  });
  await page.getByRole('button', { name: 'Scan now', exact: true }).click();
  await expect.poll(() => scans).toBe(1);
  await page.getByRole('button', { name: 'Download After the rain', exact: true }).click();
  await expect.poll(() => downloads).toBe(1);
  await page.route('**/api/home/activity', route => route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }));
  await page.reload();
  await expect(page.getByText('Could not load recent activity', { exact: true })).toBeVisible();
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan now', exact: true })).toBeEnabled();
});
