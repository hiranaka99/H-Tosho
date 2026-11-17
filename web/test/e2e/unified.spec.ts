import { expect, test, type Page } from '@playwright/test';

// Unified-search surface over the harness's deterministic provider fixtures
// (web/test/e2e-server.ts): `artist:e2e-unified` returns one cross-provider
// duplicate (groups into a single entry with two real variants) plus one
// hitomi-only result; `artist:e2e-unified-partial` returns one hitomi result
// while the nHentai lane fails, exercising the partial-failure + scoped
// retry UX. The E-Hentai lane is not configured in the harness.

async function openUnifiedTab(page: Page) {
  await page.goto('/downloader?tab=unified');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(0)).toHaveText('Search');
  await expect(tabs.nth(1)).toHaveText('Unified search');
  await expect(page.getByRole('tab', { name: 'Unified search', exact: true })).toHaveAttribute('aria-selected', 'true');
}

test.beforeEach(async ({ page }) => {
  // Keep third-party catalog availability independent of local UI checks.
  await page.route('**/api/recommendations', route => route.fulfill({ json: {
    date: '2026-10-12', generatedAt: '2026-10-12T00:00:00Z', mode: 'popular',
    profile: { artists: [], tags: [], series: [], language: null }, items: [],
    repeatedCount: 0, degradedReason: null, ownedKeys: [], dismissedKeys: [],
  } }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

async function runUnifiedQuery(page: Page, query: string) {
  await page.getByLabel('Unified search query', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('p[role="status"]')).toContainText('unique');
}

test('unified search groups the same work across providers with variant provenance', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await openUnifiedTab(page);
  await runUnifiedQuery(page, 'artist:e2e-unified');

  // The cross-provider duplicate collapses into one entry: 2 unique, not 3.
  // Both lanes are exhausted, so the exact total is reported too.
  await expect(page.locator('p[role="status"]')).toHaveText('2 unique galleries loaded · 2 total');
  await expect(page.getByRole('article')).toHaveCount(2);

  // The grouped card names its second real source.
  const grouped = page.getByRole('article').filter({ hasText: 'Unified Fixture Work' });
  await expect(grouped).toContainText('Also on:');
  await expect(grouped.getByLabel('Also found on nHentai')).toBeVisible();

  // Provider chips: both configured lanes searched; the missing account
  // explains itself with a path to Settings.
  const chips = page.getByLabel('Provider status for this search');
  await expect(chips).toContainText('Hitomi.la');
  await expect(chips).toContainText('nHentai');
  await expect(chips).toContainText('Save your E-Hentai/ExHentai account');

  // The detail modal offers every real variant of the entry.
  await page.getByRole('button', { name: 'View details for Unified Fixture Work', exact: true }).click();
  const group = page.getByRole('radiogroup', { name: 'Available from', exact: true });
  await expect(group.getByRole('radio')).toHaveCount(2);
  await expect(group).toContainText('nHentai');
  await expect(group).toContainText('Hitomi.la');
  await page.screenshot({ path: `.impeccable/review/unified-grouped-${testInfo.project.name}.png` });

  expect(errors).toEqual([]);
});

test('a failed lane keeps the other lanes visible and retries once', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await openUnifiedTab(page);
  await runUnifiedQuery(page, 'artist:e2e-unified-partial');

  // The surviving hitomi result is delivered; the nHentai lane reports its
  // failure with a scoped retry offer.
  await expect(page.locator('p[role="status"]')).toHaveText('1 unique gallery loaded');
  await expect(page.getByRole('article')).toHaveCount(1);
  const chips = page.getByLabel('Provider status for this search');
  await expect(chips).toContainText('nHentai');
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();

  // The retry re-fetches only the failed lane: the surviving result is
  // untouched and the one-time retry budget is consumed.
  await retry.click();
  await expect(page.locator('p[role="status"]')).toHaveText('1 unique gallery loaded');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);

  expect(errors).toEqual([]);
});
