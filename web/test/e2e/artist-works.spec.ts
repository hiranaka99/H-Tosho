import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const mangaDexArtist = '9abe212d-e010-413d-b0de-8c14b96c19e8';
const mangaDexWork = '12345678-1234-4234-8234-123456789abc';
const artist = (provider: string) => ({ providerId: provider, artistId: provider === 'anilist' ? '126726' : mangaDexArtist, name: provider === 'anilist' ? 'Yuu Ichinomiya' : 'Ichinomiya Yuu', aliases: [], url: provider === 'anilist' ? 'https://anilist.co/staff/126726' : `https://mangadex.org/author/${mangaDexArtist}` });
const work = (provider: string, page = 1) => ({ providerId: provider, providerSeriesId: provider === 'anilist' ? String(400 + page) : mangaDexWork, title: page === 1 ? 'An unexpected catalogue title' : 'The work found on the second page', type: 'MANGA', year: 2020 });
let applyRequests: unknown[];

test.beforeEach(async ({ page }) => {
  applyRequests = [];
  await page.route('**/api/kavita/status', route => route.fulfill({ json: { configured: true, version: '0.9.0' } }));
  await page.route('**/api/kavita/libraries', route => route.fulfill({ json: [{ id: 7, name: 'Sample library', seriesCount: 1 }] }));
  await page.route('**/api/kavita/libraries/7/series', route => route.fulfill({ json: [{ id: 11, name: 'A difficult local gallery name', libraryId: 7, status: 'unmatched', artists: ['Yuu Ichinomiya'], tags: [] }] }));
  await page.route('**/api/libraries/7/override', route => route.fulfill({ json: { libraryId: 7, priority: ['anilist', 'mangadex'], autoMatch: false } }));
  await page.route('**/api/recommendations', route => route.fulfill({ json: { items: [], ownedKeys: [], dismissedKeys: [], mode: 'popular' } }));
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: { id: 11, libraryId: 7, name: 'A difficult local gallery name' }, match: null, kavita: { summary: 'Original metadata', pencillers: [{ id: 1, name: 'Yuu Ichinomiya' }], writers: [], genres: [], tags: [] } } }));
  await page.route('**/api/series/11/identify', route => route.fulfill({ json: { candidates: [], best: null, searchedProviders: ['anilist', 'mangadex'], errors: {}, matched: false } }));
  await page.route('**/api/series/11/apply', async route => { applyRequests.push(route.request().postDataJSON()); await route.fulfill({ json: { id: 99 } }); });
  await page.route('**/api/providers/*/artists?*', route => {
    const url = new URL(route.request().url()), provider = url.pathname.split('/')[3];
    return route.fulfill({ json: { items: [artist(provider)], page: Number(url.searchParams.get('page') ?? 1), hasNextPage: false } });
  });
  await page.route('**/api/providers/*/artists/*/works?*', route => {
    const url = new URL(route.request().url()), provider = url.pathname.split('/')[3], number = Number(url.searchParams.get('page') ?? 1);
    return route.fulfill({ json: { items: [work(provider, number)], page: number, hasNextPage: provider === 'anilist' && number === 1 } });
  });
  await page.route('**/api/providers/*/series/*', route => {
    const url = new URL(route.request().url()), provider = url.pathname.split('/')[3];
    return route.fulfill({ json: { ...work(provider, 2), providerSeriesId: url.pathname.split('/').pop(), summary: 'Artist-discovered metadata for review', genres: [], tags: [], artists: ['Yuu Ichinomiya'], writers: [], titleOptions: ['The work found on the second page'] } });
  });
  await page.goto('/libraries?series=11&action=identify');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Identify “A difficult local gallery name”' })).toBeVisible();
  await page.getByRole('button', { name: 'Browse artist works', exact: true }).click();
});

test('artist browsing bypasses title matching, preserves provider pages, and reviews before applying', async ({ page }) => {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Artist name or provider artist URL')).toHaveValue('Yuu Ichinomiya');
  await expect(dialog.getByRole('button', { name: /An unexpected catalogue title/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  const chosenWork = dialog.getByRole('button', { name: /The work found on the second page/ });
  await expect(chosenWork).toBeVisible();
  await dialog.getByRole('tab', { name: 'MangaDex', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Works by Ichinomiya Yuu' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'AniList', exact: true }).click();
  await expect(chosenWork).toBeVisible();
  await chosenWork.click();
  await expect(dialog.getByText('Artist-discovered metadata for review', { exact: true })).toBeVisible();
  expect(applyRequests).toEqual([]);
  await dialog.getByRole('button', { name: 'Back to artist works', exact: true }).click();
  await expect(chosenWork).toBeFocused();
  await chosenWork.click();
  await dialog.getByRole('button', { name: 'Apply & Sync', exact: true }).click();
  await expect.poll(() => applyRequests.length).toBe(1);
  expect(applyRequests[0]).toMatchObject({ providerId: 'anilist', providerSeriesId: '402' });
});

test('example URLs select the right provider and artist works survive a recoverable provider error', async ({ page }) => {
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('Artist name or provider artist URL');
  await input.fill(`https://mangadex.org/author/${mangaDexArtist}/ichinomiya-yuu`);
  await dialog.getByRole('button', { name: 'Find artist', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'MangaDex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { name: 'Works by Ichinomiya Yuu' })).toBeVisible();
  let failing = true;
  await page.route('**/api/providers/anilist/artists?*', route => route.fulfill(failing ? { status: 502, json: { error: 'Provider temporarily unavailable' } } : { json: { items: [artist('anilist')], page: 1, hasNextPage: false } }));
  await input.fill('https://anilist.co/staff/126726/Yuu-Ichinomiya');
  await dialog.getByRole('button', { name: 'Find artist', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'AniList', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByText('Provider temporarily unavailable', { exact: true })).toBeVisible();
  failing = false;
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Works by Yuu Ichinomiya' })).toBeVisible();
});

test('artist choice, empty states, keyboard tabs and responsive themes stay usable', async ({ page }, testInfo) => {
  const dialog = page.getByRole('dialog');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  await expect(dialog.getByRole('button', { name: /An unexpected catalogue title/ })).toBeVisible();
  const output = path.resolve('.impeccable/review'); fs.mkdirSync(output, { recursive: true });
  await dialog.screenshot({ path: path.join(output, `artist-works-${testInfo.project.name}.png`) });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await dialog.screenshot({ path: path.join(output, `artist-works-${testInfo.project.name}-dark.png`) });
  await dialog.getByRole('button', { name: 'Change artist', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Yuu Ichinomiya', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'AniList', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'MangaDex', exact: true })).toBeFocused();
  await page.route('**/api/providers/*/artists?*', route => route.fulfill({ json: { items: [], page: 1, hasNextPage: false } }));
  await dialog.getByLabel('Artist name or provider artist URL').fill('Unknown artist name');
  await dialog.getByRole('button', { name: 'Find artist', exact: true }).click();
  await expect(dialog.getByText(/No artists found/)).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(viewport.width);
});
