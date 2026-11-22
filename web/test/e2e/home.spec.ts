import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { coverImage } from '../../../server/test/fixtures/coverImage';
import type { CoverHistory, RecordedCover, CoverRestorePreview } from '../../../server/src/contracts/metadataCovers';
import type { RestorePreviewRequest } from '../../../server/src/contracts/metadataRestore';

const titles = ['After the rain', 'An evening in June', 'The long way home', 'Summer sketches', 'A quiet afternoon', 'Letters from the coast'];
const items = titles.map((title, index) => ({ source: 'hitomi', galleryId: String(100 + index), title, artists: ['Sample Artist'], tags: [], language: 'English', pageCount: 24 + index * 4, reasons: ['Artist in your library'], coverUrl: `/test-cover/${index}` }));
const recommendationSet = { date: '2026-11-15', generatedAt: '2026-11-15T09:00:00Z', mode: 'library', profile: { artists: [], tags: [], series: [], language: 'English' }, items, repeatedCount: 0, degradedReason: null, ownedKeys: [], dismissedKeys: [] };
const match = { seriesId: 11, name: 'Summer anthology', libraryId: 7, libraryName: 'Doujinshi', cover: '/test-cover/2', checkedAt: '2026-11-15T09:00:00Z', candidate: { providerId: 'anilist', providerSeriesId: 'new-candidate', title: 'Summer anthology', type: 'MANGA', score: 0.98 } };
const discoveries = ['A new chapter', 'Collected sketches', 'Weekend stories', 'Late summer'].map((title, index) => ({ source: 'hitomi', galleryId: String(200 + index), title, artists: ['Another Artist'], language: 'English', pageCount: 32, coverUrl: `/test-cover/${index + 1}`, query: 'artist:another_artist', watchLabel: 'Another Artist', watchRemoved: false, foundAt: '2026-11-15T09:00:00Z', searchId: 1, reviewedAt: null }));

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

test('Home is first in navigation, shows four live sections, and shares recommendations with Discover', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link').first()).toHaveText('Home');
  if (await page.getByRole('button', { name: 'Close navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  for (const name of ['Recommended galleries', 'Matches to review', 'New in Following', 'Recent activity']) await expect(page.getByRole('heading', { name, exact: false })).toBeVisible();
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Matches to review 2 candidates', exact: true })).toBeVisible();
  const waiting = page.getByRole('navigation', { name: 'Waiting for you' });
  await expect(waiting.getByRole('link', { name: '2 matches to review', exact: true })).toBeVisible();
  await expect(waiting.getByRole('link', { name: '8 new in Following', exact: true })).toBeVisible();
  await expect(page.getByText('Showing 4 of 8. The rest are waiting in Following.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View all picks' }).click();
  await expect(page.getByRole('tab', { name: 'For you', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  await navigate(page, 'Home');
  await page.reload();
  await expect(page.getByText('After the rain', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Not a match persists the displayed candidate identity and can be undone; reviewed finds leave the inbox and can be restored', async ({ page }) => {
  let rejected = false, reviewed = false;
  await page.route('**/api/home/matches', route => route.fulfill({ json: { items: rejected ? [] : [match], configured: true, scan: null } }));
  await page.route('**/api/home/matches/11/reject', async route => {
    expect(route.request().postDataJSON()).toEqual({ providerId: 'anilist', providerSeriesId: 'new-candidate' });
    rejected = route.request().method() === 'POST';
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/watched-searches/feed?*', route => route.fulfill({ json: { items: reviewed ? [] : [discoveries[0]], total: reviewed ? 0 : 1, inboxCount: reviewed ? 0 : 1, historyCount: 1, watches: [] } }));
  await page.route('**/api/watched-searches/review', async route => {
    const body = route.request().postDataJSON();
    expect(body.items).toEqual([{ source: 'hitomi', galleryId: '200' }]);
    reviewed = body.reviewed;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Not a match', exact: true }).click();
  await expect(page.getByText('No matching candidates yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Not a match', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Not a match', exact: true }).click();
  await expect(page.getByText('No matching candidates yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(page.getByText('Nothing new to review', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(page.getByText('Nothing new to review', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('No matching candidates yet', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing new to review', { exact: true })).toBeVisible();
});

test('review opens the discovered candidate directly, returns to provider matches, and previews galleries on Home', async ({ page }, testInfo) => {
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: { id: 11, libraryId: 7, name: 'Summer anthology' }, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { providerId: 'anilist', providerSeriesId: 'new-candidate', title: 'Summer anthology', titleOptions: ['Summer anthology'], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  let searches = 0;
  let finishSearch!: () => void;
  const pendingSearch = new Promise<void>(resolve => { finishSearch = resolve; });
  await page.route('**/api/series/11/identify', async route => {
    searches++;
    await pendingSearch;
    await route.fulfill({ json: { candidates: [match.candidate, { ...match.candidate, providerId: 'mangadex', providerSeriesId: 'alternative', title: 'Alternative edition' }], best: match.candidate, searchedProviders: ['anilist', 'mangadex'], matched: false } });
  });
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Proposed summary', { exact: true })).toBeVisible();
  expect(searches).toBe(0);
  try {
    await dialog.getByRole('button', { name: 'Back to matches', exact: true }).click();
    await expect.poll(() => searches).toBe(1);
    await expect(dialog.getByText('Searching providers…', { exact: true })).toBeVisible();
  } finally { finishSearch(); }
  await expect(dialog.getByRole('button', { name: /Alternative edition/ })).toBeVisible();
  await expect(dialog.getByText('Searching providers…', { exact: true })).toHaveCount(0);
  await dialog.screenshot({ path: `.impeccable/review/home-back-to-matches-${testInfo.project.name}.png` });
  await dialog.getByRole('button', { name: /Summer anthology/ }).click();
  await expect(dialog.getByText('Proposed summary', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.route('**/api/doujin/gallery', route => route.fulfill({ json: { ...items[0], url: 'https://hitomi.la/galleries/100.html', tags: [], previewPages: [] } }));
  await page.getByRole('button', { name: 'View details for After the rain', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'After the rain', exact: true })).toBeVisible();
});

test('Home match search shows a recoverable error after Back to matches and handles an empty retry', async ({ page }) => {
  let failing = true;
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: { id: 11, libraryId: 7, name: match.name }, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.route('**/api/series/11/identify', route => route.fulfill(failing ? { status: 502, json: { error: 'Provider search temporarily unavailable' } } : { json: { candidates: [], searchedProviders: ['anilist'], matched: false } }));
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Proposed summary', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to matches', exact: true }).click();
  await expect(dialog.getByText('Could not search for matches', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Provider search temporarily unavailable', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Searching providers…', { exact: true })).toHaveCount(0);
  failing = false;
  await dialog.getByRole('button', { name: 'Retry search', exact: true }).click();
  await expect(dialog.getByText('No matches found. Try a provider URL below.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Searching providers…', { exact: true })).toHaveCount(0);
});

test('download discovery updates Home automatically and explains its review-only outcome in Tasks and Settings', async ({ page }, testInfo) => {
  let done = false;
  const job = () => ({ id: 71, type: 'scan-downloaded', payload: { path: '/downloads/Summer anthology/gallery.cbz', connectionKey: 'https://kavita.test', seriesName: match.name }, status: done ? 'completed' : 'running', progressCurrent: done ? 1 : 0, progressTotal: 1, result: done ? { processed: 1, matchable: 1, failed: 0 } : null, createdAt: '2026-11-15T09:00:00Z', startedAt: '2026-11-15T09:00:00Z', finishedAt: done ? '2026-11-15T09:01:00Z' : null, errorMessage: null });
  await page.route('**/api/home/matches', route => route.fulfill({ json: { configured: true, items: done ? [match] : [], scan: job() } }));
  await page.route('**/api/jobs', route => route.fulfill({ json: [job()] }));
  await page.route('**/api/jobs/71', route => route.fulfill({ json: { job: job(), logs: [] } }));
  await page.reload();
  await expect(page.getByText('Checking 0 of 1 galleries', { exact: true })).toBeVisible();
  await expect(page.getByText('Looking for candidates', { exact: true })).toBeVisible();
  done = true;
  await expect(page.getByRole('button', { name: 'Review match', exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Checking 0 of 1 galleries', { exact: true })).toHaveCount(0);
  await page.locator('section[aria-labelledby="home-matches"]').screenshot({ path: `.impeccable/review/download-discovery-home-${testInfo.project.name}.png` });
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: `View details for task #71: ${match.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('1 galleries checked · 1 galleries with candidates · 0 galleries with provider errors.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Find matches for downloaded gallery · Task #71', { exact: true })).toBeVisible();
  await dialog.screenshot({ path: `.impeccable/review/download-discovery-job-${testInfo.project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.route('**/api/settings/downloader', route => route.fulfill({ json: { downloadDirectory: 'C:/Downloads', format: 'cbz', maxConcurrentDownloads: 2, maxImageConcurrency: 4, requestDelayMs: 150, autoSyncKavita: false, nhentaiApiKey: '', nhentaiBannedTags: [], hitomiBannedTags: [], libraryPathMappings: [] } }));
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Downloader', exact: true }).click();
  await expect(page.getByText('Completed downloads in a shared Kavita library are imported and checked for matches in the background. Review candidates on Home before applying metadata.', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Auto-sync Kavita after downloads', exact: true })).toHaveCount(0);
});

test('field protection persists across candidate review and prevents selecting protected fields', async ({ page }, testInfo) => {
  let policy = { lockedFields: [] as string[], revision: 0 };
  await page.route('**/api/series/11/field-locks', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(policy.revision);
      policy = { lockedFields: body.lockedFields, revision: policy.revision + 1 };
    }
    await route.fulfill({ json: policy });
  });
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: { id: 11, libraryId: 7, name: match.name }, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  const panel = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Protected from H-Tosho sync' }) });
  await panel.locator('summary').click();
  await panel.getByRole('checkbox', { name: 'Description', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Description', exact: true })).toBeChecked();
  await expect(dialog.getByRole('group', { name: 'Summary', exact: true }).getByRole('checkbox')).toBeDisabled();
  expect(policy.lockedFields).toEqual(['summary']);
  await dialog.screenshot({ path: `.impeccable/review/field-protection-${testInfo.project.name}.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await dialog.screenshot({ path: `.impeccable/review/field-protection-${testInfo.project.name}-dark.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  await dialog.locator('summary').filter({ hasText: 'Protected from H-Tosho sync' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Description', exact: true })).toBeChecked();
});

test('metadata history browses observed values, archive changes and older pages', async ({ page }, testInfo) => {
  let historyRequests = 0;
  const entry = { id: 'recorded-update', sequence: 21, origin: 'provider-apply', status: 'completed', createdAt: '2026-11-16T08:00:00Z', finishedAt: '2026-11-16T08:01:00Z', fields: ['summary', 'tags'], changedFields: ['summary', 'tags'], message: null, jobId: 71 };
  const before = { series: { id: 11, libraryId: 7, name: match.name }, fields: { summary: { present: true, value: null, nativeLocked: false }, tags: { present: true, value: [] }, language: { present: false } } };
  const after = { ...before, fields: { summary: { present: true, value: '', nativeLocked: true }, tags: { present: true, value: [{ id: 1, title: 'Slice of life' }] }, language: { present: true, value: 'en' } } };
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: before.series, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.route('**/api/series/11/metadata-history?*', route => route.fulfill({ json: { items: [{ ...entry, id: 'earlier-update', sequence: 1, status: 'interrupted' }], nextCursor: null } }));
  await page.route('**/api/series/11/metadata-history', route => {
    historyRequests++;
    return route.fulfill({ json: { items: [entry], nextCursor: 21 } });
  });
  await page.route('**/api/series/11/metadata-history/recorded-update', route => route.fulfill({ json: {
    ...entry, before, after,
    archives: [{ target: 'chapter.cbz', status: 'observed', beforePresent: true, afterPresent: true, changes: [{ field: 'Number', before: { present: true, value: '1' }, after: { present: true, value: '3' } }] }],
    availability: { metadata: 'captured', archives: 'captured files only', covers: 'not captured', restore: 'not enabled' },
  } }));
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Proposed summary', { exact: true })).toBeVisible();
  expect(historyRequests).toBe(0);
  const panel = dialog.getByRole('region', { name: 'Metadata history', exact: true });
  const toggle = dialog.getByRole('button', { name: 'Metadata history', exact: true });
  await toggle.click();
  await panel.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(panel.getByText('Null', { exact: true })).toBeVisible();
  await expect(panel.getByText('Empty text', { exact: true })).toBeVisible();
  await expect(panel.getByText('Empty list', { exact: true })).toBeVisible();
  await expect(panel.getByText('Field absent', { exact: true })).toBeVisible();
  await expect(panel.getByText('Kavita lock: locked', { exact: true })).toBeVisible();
  await panel.locator('summary').filter({ hasText: 'chapter.cbz · observed' }).click();
  await expect(panel.getByText('Number', { exact: true })).toBeVisible();
  await expect(panel.getByText('3', { exact: true })).toBeVisible();
  // Layout remains 44 CSS pixels; a translated dialog's floating-point
  // viewport bounds can report 43.999992px in Chromium.
  expect(await toggle.evaluate(element => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(43.99);
  const overflow = await panel.evaluate(element => element.scrollWidth > element.clientWidth + 1);
  expect(overflow).toBe(false);
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.impeccable/review/metadata-history-${testInfo.project.name}.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `.impeccable/review/metadata-history-${testInfo.project.name}-dark.png`, animations: 'disabled' });
  await panel.getByText('Number', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.impeccable/review/metadata-history-${testInfo.project.name}-archive-dark.png`, animations: 'disabled' });
  await panel.getByRole('button', { name: 'Older changes', exact: true }).click();
  await expect(panel.getByText('Provider update · interrupted', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Newer changes', exact: true }).click();
  await expect(panel.getByText('Provider update · completed', { exact: true })).toBeVisible();
});

test('series-cover history shows retained images and locks, retries image loading and keeps uncertain readback distinct',async({page},testInfo)=>{
  const snapshot={series:{id:11,libraryId:7,name:match.name},fields:{summary:{present:true,value:'Saved description',nativeLocked:false}}};
  const base={sequence:1,origin:'provider-apply',status:'completed',createdAt:'2026-11-16T08:00:00Z',finishedAt:'2026-11-16T08:01:00Z',fields:['cover'],changedFields:['cover'],message:null,jobId:71,restoredFromOperationId:null};
  const entries=[{...base,id:'cover-change'},{...base,id:'cover-uncertain',status:'unverified',sequence:2},{...base,id:'cover-absent',sequence:3},{...base,id:'cover-legacy',sequence:4}];
  const assetBefore='a'.repeat(64),assetAfter='b'.repeat(64);
  const before={state:'captured',assetId:assetBefore,mediaType:'image/png',byteSize:coverImage(170,56,106,90,128).length,nativeLocked:true,reason:null};
  const after={...before,assetId:assetAfter,byteSize:coverImage(11,125,102,90,128).length,nativeLocked:false};
  const availability=[{field:'summary',available:true,reason:null,nativeLockAvailable:true}];
  let beforeFailed=true,approvals=0;
  await page.route('**/api/series/11/field-locks',route=>route.fulfill({json:{lockedFields:[],revision:0}}));
  await page.route('**/api/series/11',route=>route.fulfill({json:{series:snapshot.series,kavita:{summary:'Current summary'},match:null}}));
  await page.route('**/api/providers/anilist/series/new-candidate',route=>route.fulfill({json:{...match.candidate,titleOptions:[match.name],summary:'Proposed',tags:[],artists:[],writers:[],genres:[]}}));
  await page.route('**/api/series/11/metadata-history',route=>route.fulfill({json:{items:entries,nextCursor:null}}));
  for(const entry of entries)await page.route(`**/api/series/11/metadata-history/${entry.id}`,route=>route.fulfill({json:{...entry,before:snapshot,after:snapshot,archives:[],
    covers:entry.id==='cover-legacy'?undefined:{series:{kind:'series',name:'Series cover',status:entry.status==='unverified'?'unverified':'observed',before:entry.id==='cover-absent'?{state:'absent',assetId:null,mediaType:null,byteSize:null,nativeLocked:false,reason:null}:before,after:entry.status==='unverified'?{state:'unavailable',assetId:null,mediaType:null,byteSize:null,nativeLocked:null,reason:'Could not retain verified series-cover readback; inspect the current cover before any further action'}:after,
      changed:entry.status==='unverified'?null:true,requestedLock:null,writeAcknowledged:false,restoreAvailability:{before:{available:entry.id!=='cover-absent',reason:entry.id==='cover-absent'?'An absent image cannot be restored through upload':null},after:{available:entry.status!=='unverified',reason:entry.status==='unverified'?'After image was not verified':null}}},volumes:[]},
    restoreAvailability:{before:availability,after:availability},availability:{metadata:'captured',archives:'none',covers:'retained',restore:'selective'}}}));
  await page.route('**/api/series/11/metadata-history/*/assets/*',route=>{
    const isBefore=route.request().url().includes(assetBefore);
    return isBefore&&beforeFailed?route.fulfill({status:503,body:'temporarily unavailable'}):route.fulfill({contentType:'image/png',body:isBefore?coverImage(170,56,106,90,128):coverImage(11,125,102,90,128)});
  });
  await page.route('**/api/series/11/metadata-restore',route=>{approvals++;return route.fulfill({json:{id:99}});});
  await page.getByRole('button',{name:'Review match',exact:false}).first().click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await dialog.getByRole('button',{name:'View changes',exact:true}).first().click();
  let covers=dialog.getByRole('region',{name:'Cover history'});
  await covers.scrollIntoViewIfNeeded();
  await expect(covers.getByRole('button',{name:'Retry before cover',exact:true})).toBeVisible();
  await covers.evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.screenshot({path:`.impeccable/review/metadata-h4-image-error-${testInfo.project.name}-light.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h4-image-error-${testInfo.project.name}-dark.png`,animations:'disabled'});
  beforeFailed=false;await covers.getByRole('button',{name:'Retry before cover',exact:true}).click();
  await expect(covers.getByRole('img',{name:'Before recorded cover',exact:true})).toBeVisible();
  await expect.poll(()=>covers.getByRole('img',{name:'Before recorded cover',exact:true}).evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(90);
  await expect(covers.getByText('Kavita cover lock: locked',{exact:true})).toBeVisible();
  await expect(covers.getByText('Kavita cover lock: unlocked',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('region',{name:'Restore metadata'}).getByRole('checkbox',{name:'Restore Series cover',exact:true})).toBeEnabled();
  expect(await covers.evaluate(element=>element.scrollWidth>element.clientWidth+1)).toBe(false);
  await covers.evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.screenshot({path:`.impeccable/review/metadata-h4-images-${testInfo.project.name}-dark.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h4-images-${testInfo.project.name}-light.png`,animations:'disabled'});
  await dialog.getByRole('button',{name:'View changes',exact:true}).nth(1).click();
  covers=dialog.getByRole('region',{name:'Cover history'});
  await expect(covers.getByText(/Could not retain verified series-cover readback/)).toBeVisible();
  await expect(covers.getByText('Kavita cover lock: Not recorded',{exact:true})).toBeVisible();
  await covers.evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.screenshot({path:`.impeccable/review/metadata-h4-unverified-${testInfo.project.name}-light.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h4-unverified-${testInfo.project.name}-dark.png`,animations:'disabled'});
  await dialog.getByRole('button',{name:'View changes',exact:true}).nth(2).click();
  covers=dialog.getByRole('region',{name:'Cover history'});
  await expect(covers.getByText('No cover image was present.',{exact:true})).toBeVisible();
  await expect(covers.getByRole('img',{name:'Before recorded cover',exact:true})).toHaveCount(0);
  await covers.evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.screenshot({path:`.impeccable/review/metadata-h4-absence-${testInfo.project.name}-dark.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h4-absence-${testInfo.project.name}-light.png`,animations:'disabled'});
  await dialog.getByRole('button',{name:'View changes',exact:true}).nth(3).click();
  covers=dialog.getByRole('region',{name:'Cover history'});
  await expect(covers.getByRole('img')).toHaveCount(0);
  expect(approvals).toBe(0);
});

test('cover restore requires refreshed protection, explicit unreadable native locks and renewed conversion consent', async ({ page }, testInfo) => {
  const entry = { id: 'cover-restore-source', sequence: 1, origin: 'provider-apply', status: 'completed', createdAt: '2026-11-16T08:00:00Z', fields: ['cover'], changedFields: ['cover'] };
  const snapshot = { series: { id: 11, libraryId: 7, name: match.name }, fields: {} };
  const saved: RecordedCover = { state: 'captured', assetId: 'a'.repeat(64), mediaType: 'image/png', byteSize: 512, nativeLocked: true, reason: null };
  const current: RecordedCover = { ...saved, assetId: 'b'.repeat(64), nativeLocked: false };
  const history: CoverHistory = {
    series: { kind: 'series', name: 'Series cover', status: 'observed', before: saved, after: current, changed: true, requestedLock: null, writeAcknowledged: false, restoreAvailability: { before: { available: true, reason: null }, after: { available: true, reason: null } } },
    volumes: [{ kind: 'volume', volumeId: 101, name: 'Volume 1', status: 'observed', before: { ...saved, nativeLocked: null }, after: { ...current, nativeLocked: null }, changed: true, requestedLock: true, writeAcknowledged: true, restoreAvailability: { before: { available: true, reason: null }, after: { available: true, reason: null } } }],
  };
  let policy = { lockedFields: ['cover'], revision: 0 }, previews = 0, approvals = 0;
  let requested: RestorePreviewRequest;
  await page.route('**/api/series/11/field-locks', route => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); expect(body.expectedRevision).toBe(policy.revision); policy = { lockedFields: body.lockedFields, revision: policy.revision + 1 }; }
    return route.fulfill({ json: policy });
  });
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: snapshot.series, kavita: {}, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], tags: [], genres: [], writers: [], artists: [] } }));
  await page.route('**/api/series/11/metadata-history', route => route.fulfill({ json: { items: [entry], nextCursor: null } }));
  await page.route('**/api/series/11/metadata-history/cover-restore-source', route => route.fulfill({ json: { ...entry, before: snapshot, after: snapshot, archives: [], covers: history, restoreAvailability: { before: [], after: [] } } }));
  await page.route('**/api/series/11/metadata-history/*/assets/*', route => route.fulfill({ contentType: 'image/png', body: coverImage(170, 56, 106, 90, 128) }));
  await page.route('**/api/series/11/metadata-restore-previews/*/assets/*', route => route.fulfill({ contentType: 'image/png', body: coverImage(11, 125, 102, 90, 128) }));
  await page.route('**/api/series/11/metadata-history/cover-restore-source/restore-preview', route => {
    requested = route.request().postDataJSON(); previews++;
    const covers: CoverRestorePreview[] = (requested.covers ?? []).map(selection => {
      const checkpoint = selection.kind === 'series' ? history.series! : history.volumes[0];
      const nativeLock = selection.nativeLock ?? 'preserve';
      const requestedLock = nativeLock === 'locked' ? true : nativeLock === 'unlocked' ? false : nativeLock === 'saved' ? checkpoint.before.nativeLocked : checkpoint.after.nativeLocked;
      return { target: selection.kind === 'series' ? { kind: 'series' } : { kind: 'volume', volumeId: selection.volumeId! }, name: checkpoint.name, current: checkpoint.after, restoreTo: checkpoint.before, available: requestedLock !== null, reason: requestedLock === null ? 'Choose Locked or Unlocked explicitly, then refresh the preview' : null, nativeLock, requestedLock, nativeLockReadbackAvailable: checkpoint.after.nativeLocked !== null, laterEdit: false };
    });
    return route.fulfill({ json: { id: `cover-preview-${previews}`, operationId: entry.id, seriesId: 11, snapshot: requested.snapshot, expiresAt: new Date(Date.now() + 600000).toISOString(), policyRevision: policy.revision, requestedFields: [], effectiveFields: [], nativeLockFields: [], fields: [], archives: [], covers, conflicts: covers.filter(cover => !cover.available).map(cover => cover.reason), canRestore: covers.every(cover => cover.available) } });
  });
  await page.route('**/api/series/11/metadata-restore', route => {
    const body = route.request().postDataJSON(); expect(body.acceptCoverConversion).toBe(true); expect(body.previewId).toBe('cover-preview-3'); approvals++;
    return route.fulfill({ json: { id: 98 } });
  });
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await dialog.getByRole('button', { name: 'View changes', exact: true }).click();
  await dialog.locator('summary').filter({ hasText: 'Volume 1 · Volume #101' }).click();
  await expect(dialog.getByRole('region', { name: 'Cover history' }).getByText('Kavita cover lock: Not recorded', { exact: true }).first()).toBeVisible();
  const restore = dialog.getByRole('region', { name: 'Restore metadata' });
  await expect(restore.getByRole('checkbox', { name: 'Restore Series cover', exact: true })).toBeDisabled();
  await restore.getByRole('button', { name: 'Unlock cover protection', exact: true }).click();
  await restore.getByRole('checkbox', { name: 'Restore Series cover', exact: true }).check();
  await restore.getByRole('combobox', { name: 'Kavita cover lock for Series cover', exact: true }).selectOption('saved');
  await restore.getByRole('checkbox', { name: 'Restore Volume 1 (volume #101)', exact: true }).check();
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toBeDisabled();
  await expect(restore.getByText(/Choose Locked or Unlocked explicitly/).first()).toBeVisible();
  await restore.getByRole('combobox', { name: 'Kavita cover lock for Volume 1 (volume #101)', exact: true }).selectOption('locked');
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await restore.getByRole('checkbox', { name: 'I reviewed these current and restore values.' }).check();
  const consent = restore.getByRole('checkbox', { name: "I accept Kavita's image conversion and the explicitly reviewed native-lock choices/readback limits." });
  await consent.check();
  await restore.getByRole('combobox', { name: 'Kavita cover lock for Series cover', exact: true }).selectOption('unlocked');
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toHaveCount(0);
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await restore.getByRole('checkbox', { name: 'I reviewed these current and restore values.' }).check();
  await expect(consent).not.toBeChecked();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toBeDisabled();
  for (const image of await restore.getByRole('img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await expect(restore.getByText('Loading retained cover…', { exact: true })).toHaveCount(0);
  await restore.getByRole('heading', { name: 'Cover image changes', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect(restore.getByRole('img', { name: 'Current recorded cover', exact: true }).first()).toBeVisible();
  expect(await restore.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  await page.screenshot({ path: `.impeccable/review/metadata-cover-restore-${testInfo.project.name}-light.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `.impeccable/review/metadata-cover-restore-${testInfo.project.name}-dark.png`, animations: 'disabled' });
  await consent.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.impeccable/review/metadata-cover-consent-${testInfo.project.name}-dark.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.screenshot({ path: `.impeccable/review/metadata-cover-consent-${testInfo.project.name}-light.png`, animations: 'disabled' });
  await consent.check();
  expect(requested!.fields).toEqual([]);
  expect(requested!.covers?.find(cover => cover.kind === 'series')?.nativeLock).toBe('unlocked');
  expect(requested!.covers?.find(cover => cover.kind === 'volume')?.volumeId).toBe(101);
  expect(requested!.covers?.find(cover => cover.kind === 'volume')?.nativeLock).toBe('locked');
  await restore.getByRole('button', { name: 'Queue restore', exact: true }).click();
  await expect(restore.getByRole('link', { name: 'View Task #98' })).toBeVisible();
  expect(approvals).toBe(1);
});

test('metadata history retries failed loading and explains an empty history', async ({ page }) => {
  let failing = true;
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: { id: 11, libraryId: 7, name: match.name }, kavita: {}, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.route('**/api/series/11/metadata-history', route => route.fulfill(failing ? { status: 503, json: { error: 'Unavailable' } } : { json: { items: [], nextCursor: null } }));
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await expect(dialog.getByText('Could not load metadata history.', { exact: true })).toBeVisible();
  failing = false;
  await dialog.getByRole('button', { name: 'Retry history', exact: true }).click();
  await expect(dialog.getByText('No recorded metadata changes yet.', { exact: true })).toBeVisible();
});

test('metadata restore requires preview review, preserves locks by default and queues only selected fields', async ({ page }, testInfo) => {
  const entry = { id: 'restore-source', sequence: 1, origin: 'provider-apply', status: 'completed', createdAt: '2026-11-16T08:00:00Z', finishedAt: '2026-11-16T08:01:00Z', fields: ['summary', 'tags', 'writers'], changedFields: ['summary', 'tags'], message: null, jobId: 71, restoredFromOperationId: null };
  const before = { series: { id: 11, libraryId: 7, name: match.name }, fields: { summary: { present: true, value: '', nativeLocked: false }, tags: { present: true, value: [] }, writers: { present: true, value: null } } };
  const availability = [{ field: 'summary', available: true, reason: null, nativeLockAvailable: true }, { field: 'tags', available: true, reason: null, nativeLockAvailable: false }, { field: 'writers', available: false, reason: 'Null lists cannot be restored exactly', nativeLockAvailable: false }];
  let queued = 0;
  let previewCount = 0;
  let lastRequest: { snapshot: string; fields: string[]; nativeLockFields: string[] };
  await page.route('**/api/series/11/field-locks', route => route.fulfill({ json: { lockedFields: [], revision: 0 } }));
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: before.series, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.route('**/api/series/11/metadata-history', route => route.fulfill({ json: { items: [entry], nextCursor: null } }));
  await page.route('**/api/series/11/metadata-history/restore-source', route => route.fulfill({ json: { ...entry, before, after: null, archives: [], restoreAvailability: { before: availability, after: availability.map(item => ({ ...item, available: false, reason: 'After was not verified' })) }, availability: { metadata: 'captured', archives: 'none', covers: 'not captured', restore: 'selective' } } }));
  await page.route('**/api/series/11/metadata-history/restore-source/restore-preview', route => {
    lastRequest = route.request().postDataJSON();
    previewCount++;
    return route.fulfill({ json: { id: `preview-${previewCount}`, operationId: entry.id, seriesId: 11, snapshot: lastRequest.snapshot, expiresAt: new Date(Date.now() + 600000).toISOString(), policyRevision: 0, requestedFields: lastRequest.fields, effectiveFields: lastRequest.fields, nativeLockFields: lastRequest.nativeLockFields, fields: lastRequest.fields.map(field => ({ field, current: { present: true, value: field === 'summary' ? null : [{ id: 4, title: 'A later tag with a long uninterrupted value ' + 'x'.repeat(100) }], nativeLocked: true }, restoreTo: before.fields[field as keyof typeof before.fields], protected: false, available: true, reason: null, laterEdit: true })), conflicts: [], canRestore: true } });
  });
  await page.route('**/api/series/11/metadata-restore', route => {
    const body = route.request().postDataJSON();
    expect(body.previewId).toBe('preview-3');
    expect(body.idempotencyKey).toBeTruthy();
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'previewId']);
    queued++;
    return route.fulfill({ json: { id: 91 } });
  });
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply & Sync', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply & Sync', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await dialog.getByRole('button', { name: 'View changes', exact: true }).click();
  const restore = dialog.getByRole('region', { name: 'Restore metadata' });
  await expect(restore.getByRole('radio', { name: 'After (observed)' })).toBeDisabled();
  await expect(restore.getByRole('checkbox', { name: 'Writers', exact: true })).toBeDisabled();
  await expect(restore.getByText('Null lists cannot be restored exactly')).toBeVisible();
  await restore.getByRole('checkbox', { name: 'Description', exact: true }).check();
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await expect(restore.getByRole('heading', { name: 'Review restore preview' })).toBeFocused();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toBeDisabled();
  expect(lastRequest!.nativeLockFields).toEqual([]);
  await restore.getByRole('checkbox', { name: 'I reviewed these current and restore values.' }).check();
  await restore.getByRole('checkbox', { name: 'Tags', exact: true }).check();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toHaveCount(0);
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await expect(restore.getByText('Empty list', { exact: true })).toBeVisible();
  await expect(restore.getByText('Null', { exact: true })).toBeVisible();
  await restore.getByRole('checkbox', { name: 'Restore captured Kavita lock for Description' }).check();
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await expect(restore.getByText('Kavita lock: unlocked', { exact: true })).toBeVisible();
  expect(lastRequest!.nativeLockFields).toEqual(['summary']);
  await expect(restore.getByText('Later edit: restoring will replace newer values.').first()).toBeVisible();
  await restore.getByRole('checkbox', { name: 'I reviewed these current and restore values.' }).scrollIntoViewIfNeeded();
  expect(await restore.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  expect((await restore.getByRole('button', { name: 'Queue restore', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `.impeccable/review/metadata-restore-${testInfo.project.name}.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `.impeccable/review/metadata-restore-${testInfo.project.name}-dark.png`, animations: 'disabled' });
  await restore.getByRole('checkbox', { name: 'I reviewed these current and restore values.' }).check();
  await restore.getByRole('button', { name: 'Queue restore', exact: true }).click();
  await expect(restore.getByRole('link', { name: 'View Task #91' })).toHaveAttribute('href', '/jobs?job=91');
  expect(queued).toBe(1);
  expect(lastRequest!.fields).toEqual(['summary', 'tags']);
});

test('title and archive restoration reviews paired files, explicit XML replacement and stale-file conflicts', async ({page},testInfo) => {
  const entry={id:'archive-source',sequence:1,origin:'provider-apply',status:'completed',createdAt:'2026-11-16T08:00:00Z',fields:['title','archives'],changedFields:['title']};
  const before={series:{id:11,libraryId:7,name:match.name},fields:{title:{present:true,value:'Saved anthology',nativeLocked:false}}};
  const target='Chapter with a deliberately long descriptive filename '+ 'x'.repeat(70) + '.cbz';
  const availability=[{field:'title',available:true,reason:null,nativeLockAvailable:true}];
  let selected:{snapshot:string;fields:string[];archives?:{id:number;mode:string;fields?:string[]}[]};
  let previews=0,approvals=0;
  await page.route('**/api/series/11/field-locks',route=>route.fulfill({json:{lockedFields:[],revision:0}}));
  await page.route('**/api/series/11',route=>route.fulfill({json:{series:before.series,kavita:{},match:null}}));
  await page.route('**/api/providers/anilist/series/new-candidate',route=>route.fulfill({json:{...match.candidate,titleOptions:[match.name],summary:'Proposed',tags:[],artists:[],writers:[],genres:[]}}));
  await page.route('**/api/series/11/metadata-history',route=>route.fulfill({json:{items:[entry],nextCursor:null}}));
  await page.route('**/api/series/11/metadata-history/archive-source',route=>route.fulfill({json:{...entry,before,after:before,
    archives:[{id:17,target,status:'observed',beforePresent:true,afterPresent:true,changes:[{field:'Summary',before:{present:true,value:'Saved XML summary'},after:{present:true,value:'Current XML summary'}},{field:'Series',before:before.fields.title,after:{present:true,value:match.name}}]}],
    restoreAvailability:{before:availability,after:availability},availability:{metadata:'captured',archives:'captured',covers:'not captured',restore:'selective'}}}));
  await page.route('**/api/series/11/metadata-history/archive-source/restore-preview',route=>{
    selected=route.request().postDataJSON();previews++;
    const conflict=previews===3;
    const full=selected.archives?.[0]?.mode==='document';
    return route.fulfill({json:{id:`archive-preview-${previews}`,operationId:entry.id,seriesId:11,snapshot:selected.snapshot,expiresAt:new Date(Date.now()+600000).toISOString(),policyRevision:0,
      requestedFields:selected.fields,effectiveFields:selected.fields,nativeLockFields:[],
      fields:selected.fields.map(field=>({field,current:{present:true,value:match.name},restoreTo:before.fields.title,protected:false,available:true,reason:null,laterEdit:true})),
      archives:[{id:17,target,mode:full?'document':selected.archives?.length?'fields':'title',available:!conflict,reason:conflict?'Archive changed after preview; review required':null,laterEdit:true,
        changes:[{field:full?'Complete ComicInfo.xml':selected.archives?.length?'Summary':'Series',current:{present:true,value:full?'<ComicInfo custom="new"><Summary>Current XML summary</Summary><Pages><Page Image="0"/></Pages></ComicInfo>':selected.archives?.length?'Current XML summary':match.name},restoreTo:{present:true,value:full?'<ComicInfo><Summary>Saved XML summary</Summary></ComicInfo>':selected.archives?.length?'Saved XML summary':'Saved anthology'}}]}],
      conflicts:conflict?['Archive changed after preview; review required']:[],canRestore:!conflict}});
  });
  await page.route('**/api/series/11/metadata-restore',route=>{approvals++;return route.fulfill({json:{id:92}});});
  await page.getByRole('button',{name:'Review match',exact:false}).first().click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await dialog.getByRole('button',{name:'View changes',exact:true}).click();
  const restore=dialog.getByRole('region',{name:'Restore metadata'});
  await restore.getByRole('checkbox',{name:'Title',exact:true}).check();
  await restore.getByRole('button',{name:'Preview restore',exact:true}).click();
  await expect(restore.getByText(`${target} · Paired title`,{exact:true})).toBeVisible();
  await restore.getByText(`${target} · Paired title`,{exact:true}).evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.screenshot({path:`.impeccable/review/metadata-h3-paired-${testInfo.project.name}-light.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h3-paired-${testInfo.project.name}-dark.png`,animations:'disabled'});
  await restore.locator('summary').filter({hasText:target}).click();
  await restore.getByRole('checkbox',{name:`Restore Summary in ${target}`,exact:true}).check();
  await expect(restore.getByRole('heading',{name:'Review restore preview'})).toHaveCount(0);
  await restore.getByRole('button',{name:'Preview restore',exact:true}).click();
  expect(selected!.archives).toEqual([{id:17,mode:'fields',fields:['Summary']}]);
  await expect(restore.getByText('Saved XML summary',{exact:true})).toBeVisible();
  await restore.getByRole('checkbox',{name:`Replace complete ComicInfo.xml in ${target}`,exact:true}).check();
  await expect(restore.getByRole('checkbox',{name:`Restore Summary in ${target}`,exact:true})).toBeDisabled();
  await expect(restore.getByText(/This replaces all current XML with the saved document/)).toBeVisible();
  await restore.getByText(/This replaces all current XML with the saved document/).evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.screenshot({path:`.impeccable/review/metadata-h3-selection-${testInfo.project.name}-dark.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h3-selection-${testInfo.project.name}-light.png`,animations:'disabled'});
  await restore.getByRole('button',{name:'Preview restore',exact:true}).click();
  expect(selected!.archives).toEqual([{id:17,mode:'document'}]);
  await expect(restore.getByRole('button',{name:'Queue restore',exact:true})).toBeDisabled();
  await restore.getByText('Review required',{exact:true}).scrollIntoViewIfNeeded();
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h3-conflict-${testInfo.project.name}-dark.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h3-conflict-${testInfo.project.name}-light.png`,animations:'disabled'});
  await restore.getByRole('button',{name:'Refresh restore preview',exact:true}).click();
  await restore.getByRole('checkbox',{name:'I reviewed these current and restore values.'}).check();
  expect(await restore.evaluate(element=>element.scrollWidth>element.clientWidth+1)).toBe(false);
  await restore.getByRole('button',{name:'Queue restore',exact:true}).click();
  await expect(restore.getByRole('link',{name:'View Task #92'})).toBeVisible();expect(approvals).toBe(1);
});

test('metadata restore conflicts require explicit protection unlock and a fresh preview; queue errors stay reviewable', async ({ page }, testInfo) => {
  let policy = { lockedFields: [] as string[], revision: 0 };
  let previews = 0;
  let approvals = 0;
  const entry = { id: 'protected-source', sequence: 1, origin: 'provider-apply', status: 'completed', createdAt: '2026-11-16T08:00:00Z', fields: ['summary'], changedFields: ['summary'], message: null, jobId: null, restoredFromOperationId: null };
  const snapshot = { series: { id: 11, libraryId: 7, name: match.name }, fields: { summary: { present: true, value: 'Saved summary', nativeLocked: true } } };
  await page.route('**/api/series/11/field-locks', route => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); expect(body.expectedRevision).toBe(policy.revision); policy = { lockedFields: body.lockedFields, revision: policy.revision + 1 }; }
    return route.fulfill({ json: policy });
  });
  await page.route('**/api/series/11', route => route.fulfill({ json: { series: snapshot.series, kavita: { summary: 'Current summary' }, match: null } }));
  await page.route('**/api/providers/anilist/series/new-candidate', route => route.fulfill({ json: { ...match.candidate, titleOptions: [match.name], summary: 'Proposed summary', tags: [], artists: [], writers: [], genres: [] } }));
  await page.route('**/api/series/11/metadata-history', route => route.fulfill({ json: { items: [entry], nextCursor: null } }));
  await page.route('**/api/series/11/metadata-history/protected-source', route => route.fulfill({ json: { ...entry, before: snapshot, after: snapshot, archives: [], restoreAvailability: { before: [{ field: 'summary', available: true, reason: null, nativeLockAvailable: true }], after: [{ field: 'summary', available: true, reason: null, nativeLockAvailable: true }] } } }));
  await page.route('**/api/series/11/metadata-history/protected-source/restore-preview', route => {
    previews++;
    const protectedField = policy.lockedFields.includes('summary');
    return route.fulfill({ json: { id: `protected-${previews}`, seriesId: 11, operationId: entry.id, snapshot: 'before', expiresAt: new Date(Date.now() + (previews === 2 ? -1000 : 600000)).toISOString(), policyRevision: policy.revision, requestedFields: ['summary'], effectiveFields: protectedField ? [] : ['summary'], nativeLockFields: [], fields: [{ field: 'summary', current: snapshot.fields.summary, restoreTo: snapshot.fields.summary, protected: protectedField, available: true, reason: null, laterEdit: false }], conflicts: protectedField ? ['Description is protected; review required'] : [], canRestore: !protectedField } });
  });
  await page.route('**/api/series/11/metadata-restore', route => { approvals++; return route.fulfill({ status: 409, json: { error: 'Metadata changed after preview; review required' } }); });
  await page.getByRole('button', { name: 'Review match', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Metadata history', exact: true }).click();
  await dialog.getByRole('button', { name: 'View changes', exact: true }).click();
  const restore = dialog.getByRole('region', { name: 'Restore metadata' });
  await restore.getByRole('checkbox', { name: 'Description', exact: false }).first().check();
  const protection = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Protected from H-Tosho sync' }) });
  await protection.locator('summary').click();
  await protection.getByRole('checkbox', { name: 'Description', exact: true }).click();
  await expect(protection.getByRole('checkbox', { name: 'Description', exact: true })).toBeChecked();
  await expect(restore.getByRole('checkbox', { name: 'Description', exact: false }).first()).toBeDisabled();
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await expect(restore.getByText('Description is protected; review required')).toBeVisible();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toBeDisabled();
  await restore.getByText('Description is protected; review required').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.impeccable/review/metadata-restore-conflict-${testInfo.project.name}-light.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `.impeccable/review/metadata-restore-conflict-${testInfo.project.name}-dark.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await restore.getByRole('button', { name: 'Unlock Description', exact: true }).first().click();
  await expect(restore.getByRole('heading', { name: 'Review restore preview' })).toHaveCount(0);
  expect(policy.lockedFields).toEqual([]);
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await expect(restore.getByText('This preview expired. Refresh it and review current values again.')).toBeVisible();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toBeDisabled();
  await restore.getByRole('button', { name: 'Refresh restore preview', exact: true }).click();
  await restore.getByRole('radio', { name: 'After (observed)' }).check();
  await expect(restore.getByRole('heading', { name: 'Review restore preview' })).toHaveCount(0);
  await restore.getByRole('checkbox', { name: 'Description', exact: true }).check();
  await restore.getByRole('button', { name: 'Preview restore', exact: true }).click();
  await restore.getByRole('checkbox', { name: 'I reviewed these current and restore values.' }).check();
  await restore.getByRole('button', { name: 'Queue restore', exact: true }).click();
  await expect(restore.getByText('Metadata changed after preview; review required')).toBeVisible();
  await expect(restore.getByRole('button', { name: 'Queue restore', exact: true })).toHaveCount(0);
  await expect(restore.getByRole('button', { name: 'Preview restore', exact: true })).toBeEnabled();
  expect(approvals).toBe(1);
});

test('restore Tasks show verified fields and send failed restores back to series history instead of retry', async ({ page },testInfo) => {
  const base = { type: 'restore-metadata', payload: { seriesId: 11, planId: 'approved-plan' }, context: { series: [{ id: 11, name: match.name }] }, progressCurrent: 0, progressTotal: 0, createdAt: '2026-11-16T08:00:00Z', startedAt: '2026-11-16T08:01:00Z', finishedAt: '2026-11-16T08:02:00Z' };
  const completed = { ...base, id: 91, status: 'completed', result: { restored: ['summary', 'tags'], operationId: 'restored-operation' }, errorMessage: null };
  const failed = { ...base, id: 92, status: 'failed', result: null, errorMessage: 'Metadata changed after preview; review required' };
  const archiveOnly={...base,id:93,status:'completed',result:{restored:[],restoredArchives:2,operationId:'archive-restored'},errorMessage:null};
  await page.route('**/api/jobs', route => route.fulfill({ json: [completed, failed,archiveOnly] }));
  await page.route('**/api/jobs/91', route => route.fulfill({ json: { job: completed, logs: [] } }));
  await page.route('**/api/jobs/92', route => route.fulfill({ json: { job: failed, logs: [] } }));
  await page.route('**/api/jobs/93', route => route.fulfill({ json: { job: archiveOnly, logs: [] } }));
  await navigate(page, 'Tasks');
  await expect(page.getByText('Restored: Summary, Tags', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `View details for task #91: ${match.name}`, exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Verified restored fields: Summary, Tags. Inspect linked history for metadata and archive results.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `View details for task #92: ${match.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/This task cannot be retried directly/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Retry task', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Open series metadata history' })).toHaveAttribute('href', '/libraries?series=11&action=identify');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Restored: 2 archives',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:`View details for task #93: ${match.name}`,exact:true}).click();
  await expect(page.getByRole('dialog').getByText('ComicInfo.xml verified in 2 archives. Inspect linked history for metadata and archive results.',{exact:true})).toBeVisible();
  await page.screenshot({path:`.impeccable/review/metadata-h3-task-${testInfo.project.name}-light.png`,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:`.impeccable/review/metadata-h3-task-${testInfo.project.name}-dark.png`,animations:'disabled'});
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
