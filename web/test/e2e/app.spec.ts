import { expect, test, type Page } from '@playwright/test';

async function navigate(page: Page, name: string, blocked = false) {
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  const mobile = await toggle.isVisible();
  if (mobile) await toggle.click();
  const link = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name, exact: true });
  const target = await link.getAttribute('href');
  await link.click();
  if (!blocked) await expect(page).toHaveURL(url => url.pathname === target || target === '/libraries' && url.pathname.startsWith('/libraries/'));
  if (mobile && !blocked) await expect(toggle).toBeVisible(); // Wait for the drawer to close before the next navigation.
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
  await navigate(page, 'Libraries');
});

test('changing Kavita servers clears cached library series before returning to Libraries', async ({ page }) => {
  let server = 'a';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/kavita/status', route => route.fulfill({ json: { configured: true, baseUrl: `https://${server}.test`, hasApiKey: true } }));
  await page.route('**/api/kavita/libraries', route => route.fulfill({ json: [{id: 7, name: 'Manga', seriesCount: 1, matchedCount: 0}] }));
  await page.route('**/api/kavita/libraries/7/series', async route => {
    if (server === 'b') await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ json: [{id: 7, name: `Server ${server.toUpperCase()} series`, status: 'unmatched', artists: [], tags: []}] });
  });
  await page.route('**/api/libraries/7/override', route => route.fulfill({ json: {libraryId: 7, priority: [], autoMatch: false} }));
  await page.route('**/api/kavita/connection', async route => {
    server = 'b';
    await route.fulfill({ json: {saved: true, connected: true, test: 'Connected'} });
  });
  await page.goto('/libraries/7');
  await expect(page.getByText('Server A series', {exact: true})).toBeVisible();
  await navigate(page, 'Settings');
  await page.locator('#kavita-base-url').fill('https://b.test');
  const saveBar = page.getByRole('region', {name: 'Unsaved settings'});
  await saveBar.getByRole('button', {name: 'Save changes', exact: true}).click();
  await expect(saveBar.getByText('All changes saved.', {exact: true})).toBeVisible();
  await expect(page.locator('#kavita-base-url')).toBeEnabled();
  await navigate(page, 'Libraries');
  await expect(page.getByText('Server A series', {exact: true})).toHaveCount(0);
  await expect(page.getByText('Server B series', {exact: true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('login, lazy page navigation, deep links, theme and logout work', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await navigate(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await navigate(page, 'Tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await page.screenshot({ path: `.impeccable/review/navigation-tasks-${testInfo.project.name}.png` });
  await navigate(page, 'Discover');
  await expect(page.getByRole('heading', { name: 'Discover galleries', exact: true })).toBeVisible();
  await page.screenshot({ path: `.impeccable/review/navigation-discover-${testInfo.project.name}.png` });
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
  await navigate(page, 'Tasks', true);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Save your settings changes?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(interval).toHaveValue(changed);
  await navigate(page, 'Tasks', true);
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await navigate(page, 'Settings');
  await expect(interval).toHaveValue(original);
  await interval.fill(changed);
  await navigate(page, 'Tasks', true);
  await dialog.getByRole('button', { name: 'Save & leave', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await navigate(page, 'Settings');
  await expect(interval).toHaveValue(changed);
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Enable Discord notifications' });
  const checked = await toggle.getAttribute('aria-checked');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true');
});

test('watched Dismiss marks reviewed beside Download and retains reversible History', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await navigate(page, 'Settings');
  const theme = testInfo.project.name === 'desktop' ? 'Dark' : 'Light';
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: theme, exact: true }).click();
  await navigate(page, 'Discover');
  await page.getByRole('tab', { name: /^Following/ }).click();
  const inbox = page.getByRole('radio', { name: 'Inbox (6)', exact: true });
  await expect(inbox).toHaveAttribute('aria-checked', 'true');
  const card = page.locator('article').filter({ has: page.getByRole('button', { name: 'View details for History gallery 12', exact: true }) });
  const dismiss = card.getByRole('button', { name: 'Dismiss History gallery 12', exact: true });
  const download = card.getByRole('button', { name: /(?:Download|Set output folder before downloading) History gallery 12$/, exact: true });
  await expect(dismiss).toBeVisible();
  await expect(download).toBeVisible();
  const dismissBounds = await dismiss.boundingBox();
  const downloadBounds = await download.boundingBox();
  expect(Math.abs(dismissBounds!.y - downloadBounds!.y)).toBeLessThan(2);
  expect(dismissBounds!.x).toBeGreaterThan(downloadBounds!.x);
  await dismiss.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('watched-dismiss.png'), fullPage: true });

  let finishReview!: () => void;
  const pausedReview = new Promise<void>(resolve => { finishReview = resolve; });
  await page.route('**/api/watched-searches/review', async route => {
    await pausedReview;
    await route.fulfill({ status: 500, json: { error: 'Review request failed' } });
  });
  try {
    await dismiss.click();
    await expect(dismiss).toBeDisabled();
    expect(Math.abs((await dismiss.boundingBox())!.width - dismissBounds!.width)).toBeLessThan(1);
    expect(Math.abs((await download.boundingBox())!.width - downloadBounds!.width)).toBeLessThan(1);
    await expect.poll(() => card.locator('..').evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(0.6);
    await page.screenshot({ path: testInfo.outputPath('watched-review-pending.png'), fullPage: true });
  } finally { finishReview(); }
  await expect(page.getByText('Could not update Inbox', { exact: true })).toBeVisible();
  await expect(inbox).toBeVisible();
  await expect(dismiss).toBeEnabled();
  await expect.poll(() => card.locator('..').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
  await page.unroute('**/api/watched-searches/review');
  await dismiss.click();
  await expect(page.getByRole('radio', { name: 'Inbox (5)', exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole('radio', { name: 'History (13)', exact: true }).click();
  const dismissed = page.getByRole('button', { name: 'History gallery 12 dismissed from inbox', exact: true });
  await expect(dismissed).toBeDisabled();
  await page.reload();
  await page.getByRole('radio', { name: 'History (13)', exact: true }).click();
  await expect(dismissed).toBeDisabled();
  const restoredCard = page.locator('[data-gallery-motion-id="hitomi:history-12"]').locator('..');
  await restoredCard.getByRole('button', { name: 'Return to inbox', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Inbox (6)', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Inbox (6)', exact: true }).click();
  await expect(dismiss).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('watched queries use full-height autocomplete shared with Search', async ({ page }, testInfo) => {
  const suggestionRequests: { source: string; query: string }[] = [];
  const searchRequests: { source: string; query: string }[] = [];
  const watchRequests: { source: string; query: string }[] = [];
  await page.route('**/api/doujin/suggestions', async route => {
    const body = route.request().postDataJSON();
    suggestionRequests.push(body);
    await route.fulfill({ json: [
      { name: 'Mizu Artist', type: 'artist', count: 42, filter: body.source === 'hitomi' ? 'artist:mizu_artist' : 'artist:"Mizu Artist"' },
      { name: 'Mizu Group', type: 'group', count: 12, filter: body.source === 'hitomi' ? 'group:mizu_group' : 'group:"Mizu Group"' },
    ] });
  });
  await page.route('**/api/doujin/search', async route => {
    searchRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: [] });
  });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/watched-searches') watchRequests.push(request.postDataJSON());
  });
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: testInfo.project.name === 'desktop' ? 'Dark' : 'Light', exact: true }).click();
  await navigate(page, 'Discover');
  await page.getByRole('tab', { name: /^Following/ }).click();
  await page.getByText(/^Manage watches/).click();
  const form = page.getByRole('form', { name: 'Add a watched search' });
  const query = form.getByRole('combobox', { name: 'Watched search query' });
  const source = form.getByRole('combobox', { name: 'Watched search source' });
  const add = form.getByRole('button', { name: 'Add watch', exact: true });
  for (const control of [query, source, add]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText('The first check records existing galleries. Later discoveries appear in Inbox.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Unreviewed finds · newest first', { exact: true })).toHaveCount(0);

  await query.fill('language:english mi tag:landscape');
  await query.evaluate(element => (element as HTMLInputElement).setSelectionRange(19, 19));
  const option = page.getByRole('option', { name: /Mizu Artist/ });
  await expect.poll(() => suggestionRequests.at(-1)).toEqual({ source: 'hitomi', query: 'mi' });
  await expect(option).toBeVisible();
  await query.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('watched-autocomplete.png'), fullPage: true });
  await query.press('ArrowDown');
  await query.press('Enter');
  await expect(query).toHaveValue('language:english artist:mizu_artist tag:landscape');
  expect(watchRequests).toEqual([]);
  await add.click();
  await expect(query).toHaveValue('');
  expect(watchRequests.at(-1)).toEqual({ source: 'hitomi', query: 'language:english artist:mizu_artist tag:landscape' });

  await source.selectOption('nhentai');
  await query.fill('mi');
  await expect.poll(() => suggestionRequests.at(-1)).toEqual({ source: 'nhentai', query: 'mi' });
  await expect(option).toBeVisible();
  if (testInfo.project.name === 'mobile') await option.tap();
  else await option.click();
  await expect(query).toHaveValue('artist:"Mizu Artist" ');
  await page.getByRole('button', { name: 'Clear watched search query', exact: true }).click();
  await expect(query).toHaveValue('');
  await query.fill('mi');
  await expect(option).toBeVisible();
  await query.press('Escape');
  await expect(query).toHaveAttribute('aria-expanded', 'false');
  await expect(query).toHaveValue('mi');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.getByRole('radio', { name: 'nHentai', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  await search.fill('mi');
  await expect(option).toBeVisible();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(search).toHaveValue('artist:"Mizu Artist" ');
  expect(searchRequests).toEqual([]);
  await search.press('Enter');
  await expect.poll(() => searchRequests.at(-1)).toMatchObject({ source: 'nhentai', query: 'artist:"Mizu Artist"' });
});

test('Watched controls fit each viewport and failed removal can be retried', async ({ page }, testInfo) => {
  const watchQuery = `artist:polish-${testInfo.project.name} language:english tag:a_long_saved_query_for_layout_checks`;
  const created = await page.request.post('/api/watched-searches', { data: { source: 'hitomi', query: watchQuery } });
  expect(created.ok()).toBeTruthy();
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: testInfo.project.name === 'desktop' ? 'Dark' : 'Light', exact: true }).click();
  await navigate(page, 'Discover');
  await page.getByRole('tab', { name: /^Following/ }).click();
  for (const control of [
    page.getByRole('button', { name: /^Manage watches/ }),
    page.getByLabel('Filter discoveries by watch'),
    page.getByLabel('Filter discoveries by source'),
    page.getByRole('button', { name: 'Select galleries', exact: true }),
  ]) expect(Math.round((await control.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await page.locator('main').evaluate(element => element.scrollTo({ top: 0 }));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('watched-polished.png'), fullPage: true });
  expect(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 768, height: 1024 });
    const navigation = page.locator('#app-navigation');
    await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
    await expect(navigation).toBeHidden();
    await expect(page.getByRole('button', { name: /^Manage watches/ })).toBeVisible();
    expect(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('watched-tablet.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await page.getByRole('button', { name: /^Manage watches/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Manage watches', exact: true });
  for (const control of [page.getByLabel('Watched search check interval'), page.getByRole('button', { name: 'Check now', exact: true })]) expect(Math.round((await control.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  const remove = page.getByRole('button', { name: `Remove watch ${watchQuery}`, exact: true });
  await expect(remove).toBeVisible();
  expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await drawer.screenshot({ path: testInfo.outputPath('watched-manage.png') });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove watched search?', exact: true });
  let finishDelete!: () => void;
  const pausedDelete = new Promise<void>(resolve => { finishDelete = resolve; });
  const removalRoute = /\/api\/watched-searches\/\d+$/;
  await page.route(removalRoute, async route => {
    await pausedDelete;
    await route.fulfill({ status: 500, json: { error: 'Temporary watch removal failure' } });
  });
  try {
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally { finishDelete(); }
  await expect(page.getByText('Could not remove watch', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
  await expect(dialog).toBeVisible();
  await page.unroute(removalRoute);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'History (13)', exact: true })).toBeVisible();
});

test('Watched motion preserves drafts, keyboard access and reduced-motion feedback', async ({ page }, testInfo) => {
  await page.route('**/api/watched-searches', async route => {
    const response = await route.fetch();
    const watches = await response.json();
    watches[0].lastResults = [{ galleryId: 'motion-preview', title: 'Latest watched find', pageCount: 28, url: 'https://example.com/gallery' }];
    await route.fulfill({ response, json: watches });
  });
  await page.route('**/api/doujin/suggestions', route => route.fulfill({ json: [] }));
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: testInfo.project.name === 'desktop' ? 'Dark' : 'Light', exact: true }).click();
  await navigate(page, 'Discover');
  await page.getByRole('tab', { name: /^Following/ }).click();
  const manage = page.getByRole('button', { name: /^Manage watches/ });
  const drawer = page.getByRole('dialog', { name: 'Manage watches', exact: true });
  const close = page.getByRole('button', { name: 'Close dialog', exact: true });
  const query = page.getByRole('combobox', { name: 'Watched search query', exact: true });
  await expect(query).toHaveCount(0);
  await manage.focus();
  await manage.press('Enter');
  await expect(query).toBeVisible();
  await query.fill('artist:unsaved-motion-draft');
  await close.click();
  await expect(drawer).toHaveCount(0);
  await expect(manage).toBeFocused();
  await manage.press('Enter');
  await expect(query).toHaveValue('artist:unsaved-motion-draft');
  const finds = page.getByRole('button', { name: 'Show 1 latest finds for artist:history-test', exact: true });
  await finds.click();
  const latest = page.getByRole('link', { name: /Latest watched find/ });
  await expect(latest).toBeVisible();
  await page.getByRole('button', { name: 'Hide 1 latest finds for artist:history-test', exact: true }).click();
  await expect(latest).toHaveCount(0);
  await finds.click();
  await expect(latest).toBeVisible();
  await drawer.screenshot({ path: testInfo.outputPath('watched-motion-expanded.png') });
  expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await close.click();
  await expect(drawer).toHaveCount(0);
  await manage.press('Enter');
  await expect(query).toHaveValue('artist:unsaved-motion-draft');
  await close.click();
  await expect(drawer).toHaveCount(0);
  const card = page.locator('[data-gallery-motion-id="hitomi:history-12"]').locator('..');
  let finishReview!: () => void;
  const pausedReview = new Promise<void>(resolve => { finishReview = resolve; });
  await page.route('**/api/watched-searches/review', async route => {
    await pausedReview;
    await route.fulfill({ status: 500, json: { error: 'Temporary review failure' } });
  });
  try {
    await card.getByRole('button', { name: 'Dismiss History gallery 12', exact: true }).click();
    await expect.poll(() => card.evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(0.6);
    expect(await card.evaluate(element => getComputedStyle(element).transform)).toBe('none');
  } finally { finishReview(); }
  await expect(page.getByText('Could not update Inbox', { exact: true })).toBeVisible();
  await expect.poll(() => card.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
  await expect(card.getByRole('button', { name: 'Dismiss History gallery 12', exact: true })).toBeEnabled();
});

test('Hitomi search preserves exclusions, scoped autocomplete and website sort controls', async ({ page }, testInfo) => {
  const searches: { source: string; query: string; sort?: string }[] = [];
  const suggestions: { source: string; query: string; context?: string }[] = [];
  await page.route('**/api/doujin/suggestions', async route => {
    const body = route.request().postDataJSON();
    suggestions.push(body);
    if (body.query === 'artist:mi') return route.fulfill({ json: [{ name: 'Mizu Artist', type: 'artist', filter: 'artist:mizu_artist', count: 42 }] });
    // Sort suggestions use the real backend; they require no catalog access.
    if (body.query.startsWith('orderbykey:')) return route.continue();
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/doujin/search', route => {
    searches.push(route.request().postDataJSON());
    return route.fulfill({ json: [] });
  });
  await navigate(page, 'Discover');
  await page.getByRole('radio', { name: 'Hitomi.la', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  const draft = 'language:english -artist:mi type:doujinshi';
  await search.fill(draft);
  await search.evaluate((element, position) => (element as HTMLInputElement).setSelectionRange(position, position), draft.indexOf('mi') + 2);
  await expect(page.getByRole('option', { name: /Mizu Artist/ })).toBeVisible();
  expect(suggestions.at(-1)).toMatchObject({ source: 'hitomi', query: 'artist:mi' });
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(search).toHaveValue('language:english -artist:mizu_artist type:doujinshi');
  await search.press('Enter');
  await expect.poll(() => searches.at(-1)?.query).toBe('language:english -artist:mizu_artist type:doujinshi');
  const sort = page.getByRole('combobox', { name: 'Sort results', exact: true });
  for (const value of ['popular-month', 'date-published', 'random']) {
    await sort.selectOption(value);
    await expect.poll(() => searches.at(-1)?.sort).toBe(value);
  }
  await sort.selectOption('default');
  const directive = 'cat orderby:popular orderbykey:';
  await search.fill(directive);
  await expect(page.getByRole('option', { name: /month/ })).toBeVisible();
  expect(suggestions.at(-1)).toMatchObject({ query: 'orderbykey:', context: directive });
  await search.press('ArrowDown');
  await search.press('ArrowDown');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(search).toHaveValue('cat orderby:popular orderbykey:month ');
  await search.press('Enter');
  await expect.poll(() => searches.at(-1)?.query).toBe('cat orderby:popular orderbykey:month');
  await search.fill('cat OR moon -artist:evil orderbydirection:asc');
  await search.press('Escape');
  await search.press('Enter');
  await expect.poll(() => searches.at(-1)?.query).toBe('cat OR moon -artist:evil orderbydirection:asc');
  await page.screenshot({ path: testInfo.outputPath('hitomi-search.png'), fullPage: true });
});

test('Hitomi pages browse the full result count and preserve selections across pages', async ({ page }, testInfo) => {
  const requests: { offset: number; limit: number; query: string }[] = [];
  await page.route('**/api/doujin/suggestions', route => route.fulfill({ json: [] }));
  await page.route('**/api/doujin/search', route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const total = body.query === 'sample' ? 1301 : 2;
    const offset = body.offset ?? 0, limit = body.limit ?? 25;
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
      source: 'hitomi', galleryId: `sample-${offset + index + 1}`, title: `Sample gallery ${offset + index + 1}`,
      tags: [], artists: [], language: 'English', pageCount: 28,
    }));
    return route.fulfill({ json: { items, total } });
  });
  await navigate(page, 'Discover');
  await page.getByRole('radio', { name: 'Hitomi.la', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  await search.fill('sample');
  await search.press('Enter');
  await expect(page.getByText('1301 galleries found on Hitomi.la · 1–25', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select galleries', exact: true }).click();
  const first = page.locator('[data-gallery-motion-id="hitomi:sample-1"]');
  await first.getByRole('button', { name: 'Select Sample gallery 1', exact: true }).click();
  const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
  await expect(pages.getByRole('spinbutton')).toHaveCount(0);
  await expect(pages.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0);
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('1301 galleries found on Hitomi.la · 26–50', { exact: true })).toBeVisible();
  await pages.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('1301 galleries found on Hitomi.la · 1–25', { exact: true })).toBeVisible();
  await pages.getByRole('button', { name: '53', exact: true }).click();
  await expect(page.getByText('1301 galleries found on Hitomi.la · 1301–1301', { exact: true })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ offset: 1300, limit: 25 });
  await expect(pages.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await pages.screenshot({ path: `.impeccable/review/pager-${testInfo.project.name}.png` });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await pages.screenshot({ path: `.impeccable/review/pager-${testInfo.project.name}-dark.png` });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  const later = page.locator('[data-gallery-motion-id="hitomi:sample-1301"]');
  await expect(later).toBeVisible();
  await later.getByRole('button', { name: 'Select Sample gallery 1301', exact: true }).click();
  const selection = page.getByRole('region', { name: 'Merge selected galleries', exact: true }).filter({ visible: true });
  // The phone tray keeps its title list collapsed until asked.
  if (await selection.getByRole('button', { name: 'Show list', exact: true }).count()) await selection.getByRole('button', { name: 'Show list', exact: true }).click();
  await expect(selection.getByRole('list', { name: 'Selected galleries', exact: true }).getByRole('listitem')).toHaveCount(2);
  await expect(selection.getByRole('button', { name: 'Remove Sample gallery 1 from selection', exact: true })).toBeVisible();
  await expect(selection.getByRole('button', { name: 'Remove Sample gallery 1301 from selection', exact: true })).toBeVisible();
  await selection.getByRole('button', { name: 'Cancel', exact: true }).click();
  await search.fill('different');
  await search.press('Enter');
  await expect(page.getByText('2 galleries found on Hitomi.la', { exact: true })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ query: 'different', offset: 0, limit: 25 });
  await expect(page.getByRole('region', { name: 'Merge selected galleries', exact: true })).toHaveCount(0);
  await page.locator('main').evaluate(element => element.scrollTo({ top: 0 }));
  await page.screenshot({ path: testInfo.outputPath('hitomi-paged-search.png'), fullPage: true });
});

test('nHentai search keeps quoted exclusions, website sorts and selections across native pages', async ({ page }, testInfo) => {
  const suggestions: { source: string; query: string }[] = [];
  const searches: { source: string; query: string; sort?: string; offset: number; limit: number }[] = [];
  await page.route('**/api/doujin/suggestions', route => {
    const body = route.request().postDataJSON();
    suggestions.push(body);
    return route.fulfill({ json: body.query.startsWith('artists:') ? [{ name: 'Mizu Artist', type: 'artist', filter: 'artist:"Mizu Artist"', count: 42 }] : [] });
  });
  await page.route('**/api/doujin/search', route => {
    const body = route.request().postDataJSON();
    searches.push(body);
    const total = 701;
    return route.fulfill({ json: { total, items: Array.from({ length: Math.min(body.limit, total - body.offset) }, (_, index) => ({
      source: 'nhentai', galleryId: `native-${body.offset + index + 1}`, title: `Native gallery ${body.offset + index + 1}`,
      tags: [], artists: ['Mizu Artist'], pageCount: 28, language: body.query.includes('language:japanese') ? 'Japanese' : 'English',
    })) } });
  });
  await navigate(page, 'Discover');
  await page.getByRole('radio', { name: 'nHentai', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  const draft = '"exact phrase" -artists:"mi" pages:>20';
  await search.fill(draft);
  await search.evaluate((element, caret) => (element as HTMLInputElement).setSelectionRange(caret, caret), draft.indexOf('mi') + 2);
  await expect(page.getByRole('option', { name: /Mizu Artist/ })).toBeVisible();
  expect(suggestions.at(-1)).toEqual({ source: 'nhentai', query: 'artists:"mi' });
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(search).toHaveValue('"exact phrase" -artist:"Mizu Artist" pages:>20');
  await search.press('Enter');
  await expect(page.getByText('701 galleries found on nHentai · 1–25', { exact: true })).toBeVisible();
  expect(searches.at(-1)).toMatchObject({ source: 'nhentai', query: '"exact phrase" -artist:"Mizu Artist" pages:>20', offset: 0, limit: 25 });
  const sort = page.getByRole('combobox', { name: 'Sort results', exact: true });
  for (const value of ['popular', 'popular-week', 'popular-today']) {
    await sort.selectOption(value);
    await expect.poll(() => searches.at(-1)?.sort).toBe(value);
  }
  await expect(page.getByText('701 galleries found on nHentai · 1–25', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select galleries', exact: true }).click();
  await page.locator('[data-gallery-motion-id="nhentai:native-1"]').getByRole('button', { name: 'Select Native gallery 1', exact: true }).click();
  const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
  await pages.getByRole('button', { name: '29', exact: true }).click();
  await expect(page.getByText('701 galleries found on nHentai · 701–701', { exact: true })).toBeVisible();
  expect(searches.at(-1)).toMatchObject({ source: 'nhentai', offset: 700, limit: 25 });
  await page.locator('[data-gallery-motion-id="nhentai:native-701"]').getByRole('button', { name: 'Select Native gallery 701', exact: true }).click();
  const selected = page.getByRole('region', { name: 'Merge selected galleries', exact: true }).filter({ visible: true });
  if (await selected.getByRole('button', { name: 'Show list', exact: true }).count()) await selected.getByRole('button', { name: 'Show list', exact: true }).click();
  await expect(selected.getByRole('listitem')).toHaveCount(2);
  await expect(selected.getByRole('button', { name: 'Remove Native gallery 1 from selection', exact: true })).toBeVisible();
  await selected.getByRole('button', { name: 'Cancel', exact: true }).click();
  await search.fill('language:japanese title:"exact phrase" favorites:>=100 uploaded:>1m');
  await search.press('Escape');
  await search.press('Enter');
  await expect.poll(() => searches.at(-1)?.query).toBe('language:japanese title:"exact phrase" favorites:>=100 uploaded:>1m');
  await expect(page.getByText('701 galleries found on nHentai · 1–25', { exact: true })).toBeVisible();
  expect(searches.at(-1)?.offset).toBe(0);
  await page.locator('main').evaluate(element => element.scrollTo({ top: 0 }));
  await page.screenshot({ path: testInfo.outputPath('nhentai-search.png'), fullPage: true });
});

test('provider switching translates current queries, reports losses and preserves round trips', async ({ page }, testInfo) => {
  const requests: { source: string; query: string; sort?: string }[] = [];
  await page.route('**/api/doujin/suggestions', route => route.fulfill({ json: [] }));
  await page.route('**/api/doujin/search', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { items: [], total: 0 } });
  });
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: testInfo.project.name === 'desktop' ? 'Dark' : 'Light', exact: true }).click();
  await navigate(page, 'Discover');
  const query = page.getByRole('combobox', { name: 'Search galleries', exact: true });
  const hitomi = page.getByRole('radio', { name: 'Hitomi.la', exact: true });
  const nhentai = page.getByRole('radio', { name: 'nHentai', exact: true });
  const sort = page.getByRole('combobox', { name: 'Sort results', exact: true });
  await hitomi.click();
  const original = ' artist:sample_name -group:other_group language:japanese ';
  await query.fill(original);
  await sort.selectOption('popular-week');
  await query.press('Enter');
  await expect.poll(() => requests.at(-1)).toMatchObject({ source: 'hitomi', query: original.trim(), sort: 'popular-week' });
  await nhentai.click();
  await expect(query).toHaveValue('artist:"sample name" -group:"other group" language:"japanese"');
  await expect.poll(() => requests.at(-1)).toMatchObject({ source: 'nhentai', query: 'artist:"sample name" -group:"other group" language:"japanese"', sort: 'popular-week' });
  await expect(page.getByRole('status', { name: 'Search query translation' })).toHaveCount(0);
  await hitomi.click();
  await expect(query).toHaveValue(original);
  await nhentai.click();
  const advanced = 'artists:"New Name" -groups:"Other Group" pages:>20 favorites:>=100 uploaded:<7d';
  await query.fill(advanced);
  const beforeSwitch = requests.length;
  await hitomi.click();
  await expect(query).toHaveValue('artist:new_name -group:other_group');
  const notice = page.getByRole('status', { name: 'Search query translation' });
  await expect(notice).toContainText('pages:>20 is unsupported');
  await expect(notice).toContainText('favorites:>=100 is unsupported');
  await expect(notice).toContainText('uploaded:<7d is unsupported');
  await expect(page.getByText('Search for galleries', { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => JSON.parse(sessionStorage.getItem('h-tosho:downloader-state') ?? '{}').query)).toBe('artist:new_name -group:other_group');
  expect(requests).toHaveLength(beforeSwitch);
  await query.locator('xpath=ancestor::form/..').screenshot({ path: testInfo.outputPath('provider-translation.png') });
  await page.reload();
  await expect(notice).toContainText('pages:>20 is unsupported');
  await nhentai.click();
  await expect(query).toHaveValue(advanced);
  await expect(sort).toHaveValue('popular-week');
  await expect(notice).toHaveCount(0);
  await hitomi.click();
  await query.fill('artist:latest_name -language:japanese');
  await nhentai.click();
  await expect(query).toHaveValue('artist:"latest name" -language:"japanese"');
  await expect(notice).toHaveCount(0);
  await query.press('Enter');
  await expect.poll(() => requests.at(-1)).toMatchObject({ source: 'nhentai', query: 'artist:"latest name" -language:"japanese"' });
});

test('watched provider switching shares translation and retains unsupported filters on return', async ({ page }) => {
  await page.route('**/api/doujin/suggestions', route => route.fulfill({ json: [] }));
  await navigate(page, 'Discover');
  await page.getByRole('tab', { name: /^Following/ }).click();
  await page.getByRole('button', { name: /^Manage watches/ }).click();
  const form = page.getByRole('form', { name: 'Add a watched search' });
  const query = form.getByRole('combobox', { name: 'Watched search query' });
  const source = form.getByRole('combobox', { name: 'Watched search source' });
  await query.fill('artist:sample_name -group:other_group');
  await source.selectOption('nhentai');
  await expect(query).toHaveValue('artist:"sample name" -group:"other group"');
  await query.fill('artists:"New Name" pages:>20');
  await source.selectOption('hitomi');
  await expect(query).toHaveValue('artist:new_name');
  const notice = page.getByRole('status', { name: 'Watch query translation' });
  await expect(notice).toContainText('pages:>20 is unsupported');
  await source.selectOption('nhentai');
  await expect(query).toHaveValue('artists:"New Name" pages:>20');
  await expect(notice).toHaveCount(0);
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

test('Libraries searches saved tags across pages alongside titles and artists', async ({ page }, testInfo) => {
  const rows = Array.from({ length: 85 }, (_, index) => ({
    id: 5000 + index, name: index === 84 ? 'Romance title only' : `Library book ${String(index + 1).padStart(2, '0')}`,
    status: index % 2 ? 'matched' : 'unmatched', providerId: index % 2 ? 'anilist' : null,
    artists: index === 0 ? ['Test Artist'] : [],
    tags: index < 60 ? ['Romance', ...(index === 0 ? ['Slice of Life'] : [])] : index === 83 ? ['Rare Tag'] : [],
    dateAdded: '2026-10-01T00:00:00Z',
  }));
  await page.route('**/api/kavita/status', route => route.fulfill({ json: { configured: true, baseUrl: 'http://fixture.invalid', hasApiKey: true } }));
  await page.route('**/api/kavita/libraries', route => route.fulfill({ json: [{ id: 7, name: 'Manga', seriesCount: rows.length, matchedCount: 42 }] }));
  await page.route('**/api/kavita/libraries/7/series', route => route.fulfill({ json: rows }));
  await page.route('**/api/libraries/7/override', route => route.fulfill({ json: { libraryId: 7, priority: [], autoMatch: false } }));
  await page.goto('/libraries/7');
  const query = page.getByRole('textbox', { name: 'Filter series, artists or tags', exact: true });
  const cards = page.locator('[data-library-motion-id]');
  await expect(cards).toHaveCount(40);
  await query.fill('ROMANCE');
  await expect(page.getByText('61 of 85 series', { exact: true })).toBeVisible();
  await query.fill('tag:romance');
  await expect(page.getByText('60 of 85 series', { exact: true })).toBeVisible();
  const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
  await pages.getByRole('button', { name: '2', exact: true }).click();
  await expect(cards).toHaveCount(20);
  await expect(cards.first()).toContainText('Tags · Romance');
  const matchFilter = page.getByRole('group', { name: 'Filter by match status' });
  await matchFilter.getByRole('button', { name: /^Matched\b/ }).click();
  await expect(page.getByText('30 of 85 series', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(30);
  await matchFilter.getByRole('button', { name: /^All\b/ }).click();
  await query.fill('tag:"slice of life"');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Library book 01');
  await expect(cards.first()).toContainText('Tags · Slice of Life');
  await query.fill('tag:rare');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Library book 84');
  await expect(cards.first()).toContainText('Tags · Rare Tag');
  await expect(page.getByText('1 of 85 series', { exact: true })).toBeVisible();
  await page.reload();
  await expect(query).toHaveValue('tag:rare');
  await expect(cards).toHaveCount(1);
  await page.locator('main').screenshot({ path: testInfo.outputPath('library-tag-search.png') });
  await query.fill('Test Artist');
  await expect(cards).toHaveCount(1);
  await query.fill('tag:missing');
  await expect(page.getByText('No matching series', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(query).toHaveValue('');
  await expect(cards).toHaveCount(40);
  expect(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
});

test('daily recommendations stay fixed and returning from Libraries restores For you', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-12T12:00:00Z') });
  let day = '2026-10-12';
  let reads = 0, refreshes = 0;
  let excludedLibraryIds: number[] = [];
  const titles = new Map<string, string>();
  const picks = () => ({
    date: day, generatedAt: `${day}T12:00:00Z`, mode: 'popular',
    profile: { artists: [], tags: [], series: [], language: null }, repeatedCount: 0, degradedReason: null, ownedKeys: [], dismissedKeys: [],
    items: [{ source: 'hitomi', galleryId: `${day}-${refreshes}`, title: titles.get(day) ?? `Daily pick ${day}`, artists: [], tags: [], reasons: [], pageCount: 28 }],
  });
  await page.route('**/api/recommendations', async route => { reads++; await route.fulfill({ json: picks() }); });
  await page.route('**/api/recommendations/refresh', async route => { refreshes++; titles.set(day, 'Manually refreshed pick'); await route.fulfill({ json: picks() }); });
  await page.route('**/api/recommendations/libraries', route => route.fulfill({ json: [{ id: 7, name: 'Manga' }] }));
  await page.route('**/api/recommendations/settings', async route => {
    if (route.request().method() === 'POST') excludedLibraryIds = route.request().postDataJSON().excludedLibraryIds;
    await route.fulfill({ json: { excludedLibraryIds } });
  });
  await page.route('**/api/downloads/library-matches', route => route.fulfill({ json: { items: [], incomplete: false, errors: [] } }));
  await page.route('**/api/doujin/search', route => route.fulfill({ json: { items: [], total: 0 } }));
  // App startup loads the day's picks while Libraries is still open.
  await page.reload();
  await expect.poll(() => reads).toBe(1);
  await navigate(page, 'Discover');
  const recommended = page.getByRole('tab', { name: 'For you', exact: true });
  await recommended.click();
  await expect(page.getByText('Daily pick 2026-10-12', { exact: true })).toBeVisible();
  await navigate(page, 'Libraries');
  await page.clock.fastForward('06:00'); // Beyond both stale and garbage-collection defaults.
  await navigate(page, 'Discover');
  await expect(recommended).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Daily pick 2026-10-12', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  await page.getByRole('group', { name: 'Libraries used for recommendations' }).getByRole('button', { name: 'Manga', exact: true }).click();
  await expect.poll(() => excludedLibraryIds).toEqual([7]);
  await expect(page.getByText('Daily pick 2026-10-12', { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  expect(refreshes).toBe(0);
  await page.getByRole('button', { name: 'Refresh picks', exact: true }).click();
  await expect(page.getByText('Manually refreshed pick', { exact: true })).toBeVisible();
  expect(refreshes).toBe(1);
  expect(reads).toBe(1);
  // Reopening on the same day reads the same persisted server selection.
  await page.reload();
  await expect(recommended).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Manually refreshed pick', { exact: true })).toBeVisible();
  expect(reads).toBe(2);
  day = '2026-10-13';
  await page.clock.fastForward('24:00:00');
  await expect(page.getByText('Manually refreshed pick', { exact: true })).toBeVisible();
  expect(reads).toBe(2);
  // The new daily set loads only at the next app opening.
  await page.reload();
  await expect(page.getByText('Daily pick 2026-10-13', { exact: true })).toBeVisible();
  expect(reads).toBe(3);
  await page.goto('/downloader?source=hitomi&q=artist:sample');
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveAttribute('aria-selected', 'true');
  await recommended.click();
  await expect(recommended).toHaveAttribute('aria-selected', 'true');
  await navigate(page, 'Libraries');
  await navigate(page, 'Discover');
  await expect(recommended).toHaveAttribute('aria-selected', 'true');
  expect(reads).toBe(4); // The explicit full-page deep link is an app opening too.
  expect(refreshes).toBe(1);
});

test('a failed initial recommendation load retries only on an explicit Retry', async ({ page }) => {
  let reads = 0;
  let recover = false;
  await page.route('**/api/recommendations', async route => {
    reads++;
    await route.fulfill(recover ? { json: { date: '2026-10-12', generatedAt: '2026-10-12T12:00:00Z', mode: 'popular', profile: { artists: [], tags: [], series: [], language: null }, items: [], repeatedCount: 0, degradedReason: 'insufficient-eligible' } } : { status: 503, json: { error: 'Temporarily unavailable' } });
  });
  await page.reload();
  await expect.poll(() => reads).toBe(1);
  await navigate(page, 'Discover');
  await page.getByRole('tab', { name: 'For you', exact: true }).click();
  await expect(page.getByText('Recommendations failed', { exact: true })).toBeVisible();
  await navigate(page, 'Libraries');
  await navigate(page, 'Discover');
  await expect(page.getByText('Recommendations failed', { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  recover = true;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('No picks available', { exact: true })).toBeVisible();
  expect(reads).toBe(2);
});
