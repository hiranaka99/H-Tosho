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
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toHaveText('Search');
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('radio', { name: 'All sources', exact: true })).toBeChecked();
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
  await page.getByLabel('Search galleries', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('p[role="status"]')).toContainText(/galler(y|ies)/);
}

test('unified and E-Hentai autocomplete replace the active term without submitting', async ({ page }, testInfo) => {
  const requests: { source: string; query: string }[] = [];
  await page.route('**/api/doujin/suggestions', route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ json: [{ source: 'ehentai', type: 'artist', name: 'Sample Artist', filter: body.source === 'unified' ? 'artist:"Sample Artist"' : 'artist:"Sample Artist$"' }] });
  });
  await openUnifiedTab(page);
  const input = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  await input.fill('-artist:sam');
  await expect(page.getByRole('option', { name: /Sample Artist/ })).toBeVisible();
  await page.screenshot({ path: `.impeccable/review/unified-autocomplete-${testInfo.project.name}.png` });
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue('-artist:"Sample Artist" ');
  await expect(page.getByText('Search every source at once', { exact: true })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ source: 'unified', query: 'artist:sam' });

  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.getByRole('radio', { name: 'E-Hentai', exact: true }).click();
  const native = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  await native.fill('artist:sam');
  await expect(page.getByRole('option', { name: /Sample Artist/ })).toBeVisible();
  await page.screenshot({ path: `.impeccable/review/ehentai-autocomplete-${testInfo.project.name}.png` });
  await page.getByRole('option', { name: /Sample Artist/ }).click();
  await expect(native).toHaveValue('artist:"Sample Artist$" ');
  expect(requests.at(-1)).toMatchObject({ source: 'ehentai', query: 'artist:sam' });
});

test('unified search groups the same work across providers with variant provenance', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await openUnifiedTab(page);
  await runUnifiedQuery(page, 'artist:e2e-unified');

  // The cross-provider duplicate collapses into one entry: 2 unique, not 3.
  // Both lanes are exhausted, so the exact total is reported too.
  await expect(page.locator('p[role="status"]')).toHaveText('2 galleries across sources');
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
  await expect(group.getByRole('radio').filter({ hasText: 'nHentai' })).toContainText('[Digital]');
  await page.getByRole('dialog').evaluate(async element => {
    await Promise.allSettled(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished));
  });
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
  await expect(page.locator('p[role="status"]')).toHaveText('Showing 1 gallery');
  await expect(page.getByRole('article')).toHaveCount(1);
  const chips = page.getByLabel('Provider status for this search');
  await expect(chips).toContainText('nHentai');
  const retry = page.getByRole('button', { name: 'Retry nHentai', exact: true });
  await expect(retry).toBeVisible();

  // The retry re-fetches only the failed lane: the surviving result is
  // untouched and the one-time retry budget is consumed.
  await retry.click();
  await expect(page.locator('p[role="status"]')).toHaveText('Showing 1 gallery');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Retry nHentai', exact: true })).toHaveCount(0);

  expect(errors).toEqual([]);
});
