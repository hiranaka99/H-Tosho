import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Job } from '../src/jobs/executor.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-scan-new-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// The DB module reads HTOSHO_DATA_DIR at module initialization, so these test imports must follow the environment setup.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { setKavitaConnection } = await import('../src/services/settings.js');

const { runJob } = await import('../src/jobs/executor.js');
initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'secret' });
const originalFetch = globalThis.fetch;

function makeJob(id: number, payload: Record<string, unknown>): Job {
  return {
    id,
    type: 'scan-new',
    payload,
    status: 'running',
    progressCurrent: 0,
    progressTotal: 0,
    result: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

function insertMatchRow(kavitaSeriesId: number, status: string): void {
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId,
      status,
      providerId: null,
      providerSeriesId: null,
      matchScore: null,
      metadataJson: null,
      errorMessage: null,
      aligned: false,
    })
    .run();
}

test('global scan-new triggers a Kavita scan before listing series and skips auto-match-disabled libraries', async () => {
  getDb().insert(schema.libraryOverrides).values({ libraryId: 2, priorityJson: '[]', autoMatch: false }).run();
  insertMatchRow(102, 'matched');

  const requests: string[] = [];
  let libraryCalls = 0;
  let seriesCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/api/Library/libraries')) {
      libraryCalls += 1;
      // Call 1 scopes the job, call 2 is the first completion poll (scan still
      // in flight), call 3 sees fresh lastScanned values and releases the wait.
      const scanned = libraryCalls >= 3;
      return Response.json([
        { id: 1, name: 'Lib A', type: 0, folders: [dataDir], lastScanned: scanned ? '2026-08-25T12:01:00' : '2026-08-25T12:00:00' },
        { id: 2, name: 'Lib B', type: 0, folders: [dataDir], lastScanned: scanned ? '2026-08-25T12:01:01' : '2026-08-25T12:00:01' },
      ]);
    }
    if (url.endsWith('/api/Library/scan-all')) return Response.json({});
    if (url.includes('/api/Series/all-v2?')) {
      seriesCalls += 1;
      // The server filters by library, so each call returns that library's series.
      return Response.json(seriesCalls === 1 ? [{ id: 101, libraryId: 1, name: 'S101' }, { id: 102, libraryId: 1, name: 'S102' }] : [{ id: 201, libraryId: 2, name: 'S201' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const summary = await runJob(makeJob(900, {}), () => undefined);

  const scanAllIndex = requests.findIndex((u) => u.endsWith('/api/Library/scan-all'));
  const firstSeriesIndex = requests.findIndex((u) => u.includes('/api/Series/all-v2?'));
  assert.ok(scanAllIndex !== -1 && firstSeriesIndex !== -1, 'expected both scan-all and series listing');
  assert.ok(scanAllIndex < firstSeriesIndex, `Kavita scan (${scanAllIndex}) must precede series listing (${firstSeriesIndex})`);
  assert.equal(libraryCalls, 3, 'completion polled until every library reported a fresh lastScanned');
  assert.equal(seriesCalls, 2, 'every library is listed so orphaned match rows can be detected');
  assert.deepEqual(summary, { processed: 1, matched: 0, failed: 1, libraries: 2 });

  const rows = new Map(getDb().select().from(schema.seriesMatches).all().map((r) => [r.kavitaSeriesId, r.status]));
  assert.equal(rows.get(101), 'unmatched', 'never-seen series in enabled library is processed');
  assert.equal(rows.get(102), 'matched', 'already-matched series is left untouched');
  assert.equal(rows.has(201), false, 'series in auto-match-disabled library must not be matched');
});

test('library-scoped scan-new requests a single-library Kavita scan', async () => {
  const requests: string[] = [];
  let libraryCalls = 0;
  let seriesCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/api/Library/libraries')) {
      libraryCalls += 1;
      return Response.json([
        { id: 1, name: 'Lib A', type: 0, folders: [dataDir], lastScanned: libraryCalls === 1 ? '2026-08-25T12:00:00' : '2026-08-25T12:01:00' },
        { id: 2, name: 'Lib B', type: 0, folders: [dataDir], lastScanned: '2026-08-25T12:00:02' },
      ]);
    }
    if (url.includes('/api/Library/scan?libraryId=1')) return Response.json({});
    if (url.includes('/api/Series/all-v2?')) {
      seriesCalls += 1;
      return Response.json([{ id: 103, libraryId: 1, name: 'S103' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const summary = await runJob(makeJob(901, { libraryId: 1 }), () => undefined);

  assert.ok(requests.some((u) => u.includes('/api/Library/scan?libraryId=1')), 'per-library scan requested');
  assert.ok(!requests.some((u) => u.endsWith('/api/Library/scan-all')), 'scan-all must not be used for a scoped run');
  assert.equal(seriesCalls, 1);
  assert.deepEqual(summary, { processed: 1, matched: 0, failed: 1, libraries: 1 });
});
test('global scan-new prunes match rows for series no longer present in Kavita', async () => {
  // Rows from earlier tests: 101 (unmatched), 102 (matched) — both still live in the mock.
  insertMatchRow(999, 'matched');

  let libraryCalls = 0;
  let seriesCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) {
      libraryCalls += 1;
      const scanned = libraryCalls >= 3;
      return Response.json([
        { id: 1, name: 'Lib A', type: 0, folders: [dataDir], lastScanned: scanned ? '2026-08-25T13:01:00' : '2026-08-25T13:00:00' },
        { id: 2, name: 'Lib B', type: 0, folders: [dataDir], lastScanned: scanned ? '2026-08-25T13:01:01' : '2026-08-25T13:00:01' },
      ]);
    }
    if (url.endsWith('/api/Library/scan-all')) return Response.json({});
    if (url.includes('/api/Series/all-v2?')) {
      seriesCalls += 1;
      // Series 999 exists in neither library — its match row is orphaned.
      return Response.json(
        seriesCalls === 1 ? [{ id: 101, libraryId: 1, name: 'S101' }, { id: 102, libraryId: 1, name: 'S102' }, { id: 103, libraryId: 1, name: 'S103' }] : [{ id: 201, libraryId: 2, name: 'S201' }],
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const summary = await runJob(makeJob(902, {}), () => undefined);

  assert.equal(summary.pruned, 1, 'orphaned row is pruned on a global scan');
  const rows = new Map(getDb().select().from(schema.seriesMatches).all().map((r) => [r.kavitaSeriesId, r.status]));
  assert.equal(rows.has(999), false, 'pruned row is gone');
  assert.equal(rows.get(102), 'matched', 'rows for live series are kept');
});

test('library-scoped scan-new does not prune match rows it cannot see', async () => {
  insertMatchRow(998, 'matched');

  let libraryCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) {
      libraryCalls += 1;
      return Response.json([
        { id: 1, name: 'Lib A', type: 0, folders: [dataDir], lastScanned: libraryCalls === 1 ? '2026-08-25T14:00:00' : '2026-08-25T14:01:00' },
        { id: 2, name: 'Lib B', type: 0, folders: [dataDir], lastScanned: '2026-08-25T14:00:02' },
      ]);
    }
    if (url.includes('/api/Library/scan?libraryId=1')) return Response.json({});
    if (url.includes('/api/Series/all-v2?')) {
      return Response.json([{ id: 103, libraryId: 1, name: 'S103' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const summary = await runJob(makeJob(903, { libraryId: 1 }), () => undefined);

  assert.equal(summary.pruned, undefined, 'scoped scan must not prune rows outside its scope');
  const rows = new Map(getDb().select().from(schema.seriesMatches).all().map((r) => [r.kavitaSeriesId, r.status]));
  assert.equal(rows.get(998), 'matched', 'row outside the scoped library is untouched');
});
