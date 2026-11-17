import { expect, test } from '@playwright/test';

test('Watched keeps large saved lists cheap and follows checks promptly', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const baseline = process.env.HTOSHO_WATCHED_BASELINE === '1';
  const watches = Array.from({ length: 52 }, (_, index) => ({
    id: index + 1000, source: 'hitomi', query: `artist:performance_${index}`,
    displayName: null, folderId: null, pausedAt: null, intervalMinutes: null,
    effectiveIntervalMinutes: 15, nextCheckAt: '2026-11-16T12:15:00Z', revision: 0, coverageLimit: 50,
    lastCheckedAt: null, lastResultCount: 20, seenCount: 20, lastNewCount: 20,
    lastFindsAt: null, lastAttemptedAt: null, lastFailedAt: null, lastError: null,
    lastResults: Array.from({ length: 20 }, (_, find) => ({
      galleryId: `sample-${index}-${find}`, title: `Saved find ${index}-${find}`,
      pageCount: 28, url: 'https://example.com/gallery',
    })),
  }));
  let statusRequests = 0;
  let active = false;
  let activeRequests = 0;
  await page.route('**/api/watched-searches', route => route.fulfill({ json: watches }));
  await page.route('**/api/watched-searches/check-status', route => {
    statusRequests++;
    if (!active) return route.fulfill({ json: null });
    activeRequests++;
    const completed = activeRequests >= 3;
    return route.fulfill({ json: {
      id: 9000, type: 'check-watched-searches', status: completed ? 'completed' : 'running',
      progressCurrent: completed ? 52 : activeRequests, progressTotal: 52,
      result: completed ? { newGalleries: 3, failed: 0, processed: 52 } : null,
      finishedAt: completed ? new Date().toISOString() : null,
    } });
  });
  await page.route('**/api/watched-searches/check', route => {
    active = true;
    return route.fulfill({ json: { id: 9000 } });
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('upgrade-test');
  await page.getByLabel('Password', { exact: true }).fill('upgrade-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  const session = await page.context().newCDPSession(page);
  // Controlled browser workload, not a claim about real-device speed or Web Vitals.
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await session.send('Performance.enable');
  await page.goto('/downloader?tab=watched');
  const manage = page.getByRole('button', { name: 'Manage watches (52)', exact: true });
  await expect(manage).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Inbox \(/ })).toBeVisible();
  const closed = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    savedRows: document.querySelectorAll('[data-watched-search-id]').length,
  }));
  const initialRequests = statusRequests;
  await page.waitForTimeout(8000);
  const idlePolls = statusRequests - initialRequests;
  const openStart = Date.now();
  await manage.click();
  const query = page.getByRole('combobox', { name: 'Watched search query', exact: true });
  await expect(query).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const openMs = Date.now() - openStart;
  const expanded = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    savedFinds: document.querySelectorAll('a[href="https://example.com/gallery"]').length,
  }));
  const report = { project: testInfo.project.name, phase: baseline ? 'before' : 'after', cpuThrottle: 4, watches: 52, findsPerWatch: 20, closed, expanded, idlePollsIn8Seconds: idlePolls, openMs };
  console.log(`WATCHED_PERFORMANCE ${JSON.stringify(report)}`);
  await testInfo.attach('watched-performance', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  if (baseline) return;
  expect(closed.savedRows).toBe(0);
  expect(expanded.savedFinds).toBe(0);
  expect(idlePolls).toBe(0);
  const finds = page.getByRole('button', { name: 'Show 20 latest finds for artist:performance_0', exact: true });
  await finds.click();
  await expect(page.getByRole('link', { name: /Saved find 0-0/ })).toBeVisible();
  expect(await page.locator('a[href="https://example.com/gallery"]').count()).toBe(20);
  await page.getByRole('button', { name: 'Hide 20 latest finds for artist:performance_0', exact: true }).click();
  await expect(page.locator('a[href="https://example.com/gallery"]')).toHaveCount(0);
  await manage.locator('..').screenshot({ path: testInfo.outputPath('watched-large-list.png') });
  await manage.click();
  await expect(page.locator('[data-watched-search-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByText(/Checking \d+ of 52 watches/)).toBeVisible();
  await expect(page.getByText(/^3 new finds/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  const requestsAfterLeaving = statusRequests;
  await page.waitForTimeout(3000);
  expect(statusRequests).toBe(requestsAfterLeaving);
});
