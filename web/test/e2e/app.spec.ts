import { expect, test, type Page } from '@playwright/test';

async function navigate(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name, exact: true }).click();
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
  await expect(page).toHaveURL(/\/libraries$/);
});

test('login, lazy page navigation, deep links, theme and logout work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await navigate(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await navigate(page, 'Jobs');
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  await navigate(page, 'Downloader');
  await expect(page.getByRole('heading', { name: 'Doujinshi Downloader', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Downloads', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Downloads', exact: true })).toHaveAttribute('aria-selected', 'true');
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('unsaved settings can stay, discard, or save before navigating', async ({ page }) => {
  await navigate(page, 'Settings');
  const interval = page.getByLabel('Hours between background scans', { exact: true });
  const original = await interval.inputValue();
  const changed = original === '13' ? '14' : '13';
  await interval.fill(changed);
  await navigate(page, 'Jobs');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Save your settings changes?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(interval).toHaveValue(changed);
  await navigate(page, 'Jobs');
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  await navigate(page, 'Settings');
  await expect(interval).toHaveValue(original);
  await interval.fill(changed);
  await navigate(page, 'Jobs');
  await dialog.getByRole('button', { name: 'Save & leave', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  await navigate(page, 'Settings');
  await expect(interval).toHaveValue(changed);
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Enable Discord notifications' });
  const checked = await toggle.getAttribute('aria-checked');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true');
});

test('authenticated download events stream over the upgraded HTTP adapter', async ({ page }) => {
  const snapshot = await page.evaluate(() => new Promise<{ type: string; tasks: unknown[] }>((resolve, reject) => {
    const events = new EventSource('/api/downloads/events');
    const timer = setTimeout(() => { events.close(); reject(new Error('No download snapshot received')); }, 5000);
    events.onmessage = event => {
      clearTimeout(timer);
      events.close();
      resolve(JSON.parse(event.data));
    };
    events.onerror = () => { clearTimeout(timer); events.close(); reject(new Error('Download stream failed')); };
  }));
  expect(snapshot.type).toBe('snapshot');
  expect(snapshot.tasks).toEqual([]);
});
