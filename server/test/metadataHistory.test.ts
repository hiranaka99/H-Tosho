import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { KavitaClient } from '../src/kavita/client.js';
import { buildZip } from '../src/downloader/zip.js';
import { setComicInfoFields } from '../src/lib/cbz.js';
import { migrateSchema } from '../src/db/migrations.js';
import { pruneMetadataHistory } from '../src/db/metadataRetention.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-metadata-history-'));
process.env.HTOSHO_DATA_DIR = directory;
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { setKavitaConnection } = await import('../src/services/settings.js');
const { withMetadataHistory, listMetadataHistory, metadataHistoryDetail, interruptMetadataHistory } = await import('../src/services/metadataHistory.js');
const { api } = await import('../src/routes/api/series.js');
initDb();
setKavitaConnection({ baseUrl: 'https://history.test', apiKey: 'never-store-this' });

function fixture(id: number) {
  const series: Record<string, unknown> = { id, libraryId: 7, name: 'Original title', nameLocked: false };
  const metadata: Record<string, unknown> = { summary: null, tags: [], writers: [], summaryLocked: false };
  const client = {
    getSeriesDto: async () => structuredClone(series),
    getSeriesMetadata: async () => structuredClone(metadata),
  } as unknown as KavitaClient;
  return { client, series, metadata };
}

test('commits actual before values before mutation and retains null, absent, empty and native locks', async () => {
  const { client, metadata } = fixture(1);
  await withMetadataHistory(client, 1, 'provider-apply', { summary: '' }, async () => {
    const running = listMetadataHistory(1).items[0];
    assert.equal(running.status, 'running');
    const saved = metadataHistoryDetail(1, running.id)!;
    assert.deepEqual(saved.before.fields.summary, { present: true, value: null, nativeLocked: false });
    assert.deepEqual(saved.before.fields.tags, { present: true, value: [] });
    assert.deepEqual(saved.before.fields.language, { present: false });
    metadata.summary = '';
    metadata.summaryLocked = true;
    return { errors: [] };
  }, 123);
  const entry = listMetadataHistory(1).items[0];
  const detail = metadataHistoryDetail(1, entry.id)!;
  assert.equal(entry.status, 'completed');
  assert.equal(entry.jobId, 123);
  assert.deepEqual(detail.after!.fields.summary, { present: true, value: '', nativeLocked: true });
  assert.deepEqual(entry.changedFields, ['summary']);
  assert.equal(detail.availability.covers, 'not captured');
  assert.equal(detail.availability.restore, 'not enabled');
  assert.equal(JSON.stringify(detail).includes('never-store-this'), false);
});

test('a failed authoritative read or changed identity blocks the first write', async () => {
  const { client, series } = fixture(2);
  let writes = 0;
  client.getSeriesMetadata = async () => { throw new Error('Kavita unavailable'); };
  await assert.rejects(withMetadataHistory(client, 2, 'provider-apply', {}, async () => { writes++; }), /Kavita unavailable/);
  assert.equal(writes, 0);
  assert.deepEqual(listMetadataHistory(2).items, []);
  const other = fixture(2);
  other.series.id = 99;
  await assert.rejects(withMetadataHistory(other.client, 2, 'provider-apply', {}, async () => { writes++; }), /identity/);
  assert.equal(writes, 0);
  assert.equal(series.id, 2);
});

test('partial writes and cancellation keep observed after values without swallowing the error', async () => {
  const { client, metadata } = fixture(3);
  const failure = new Error('Connection lost after write');
  await assert.rejects(withMetadataHistory(client, 3, 'provider-apply', { summary: 'Changed' }, async () => {
    metadata.summary = 'Changed';
    throw failure;
  }), error => error === failure);
  let entry = listMetadataHistory(3).items[0];
  assert.equal(entry.status, 'partial');
  assert.equal(metadataHistoryDetail(3, entry.id)!.after!.fields.summary.value, 'Changed');
  const cancelled = new Error('Cancelled');
  cancelled.name = 'JobCancelled';
  await assert.rejects(withMetadataHistory(client, 3, 'comicinfo-edit', {}, async () => { throw cancelled; }));
  entry = listMetadataHistory(3).items[0];
  assert.equal(entry.status, 'cancelled');
});

test('silent remote no-ops and failed readback are unverified instead of completed', async () => {
  const { client } = fixture(4);
  await withMetadataHistory(client, 4, 'provider-apply', { summary: 'Requested' }, async () => ({}));
  assert.equal(listMetadataHistory(4).items[0].status, 'unverified');
  assert.match(listMetadataHistory(4).items[0].message!, /summary/);
  await withMetadataHistory(client, 4, 'provider-apply', {}, async () => {
    client.getSeriesMetadata = async () => { throw new Error('Offline after write'); };
  });
  const entry = listMetadataHistory(4).items[0];
  assert.equal(entry.status, 'unverified');
  assert.equal(metadataHistoryDetail(4, entry.id)!.after, null);
});

test('archive XML is committed before editing; browse shows field changes without exposing paths', async () => {
  const { client } = fixture(5);
  const file = path.join(directory, 'original.cbz');
  fs.writeFileSync(file, buildZip([{ name: '001.jpg', data: Buffer.from('image') }]));
  await withMetadataHistory(client, 5, 'comicinfo-edit', { Number: '3' }, async journal => {
    await journal.captureArchives([file, file]);
    const step = getDb().select().from(schema.metadataOperationSteps).get()!;
    assert.equal(JSON.parse(step.beforeJson).xml, null);
    assert.equal(step.afterJson, null);
    await setComicInfoFields(file, { Number: '3' });
  });
  const entry = listMetadataHistory(5).items[0];
  const detail = metadataHistoryDetail(5, entry.id)!;
  assert.equal(detail.archives.length, 1);
  assert.equal(detail.archives[0].target, 'original.cbz');
  assert.equal(detail.archives[0].beforePresent, false);
  assert.equal(detail.archives[0].afterPresent, true);
  assert.deepEqual(detail.archives[0].changes.find(change => change.field === 'Number'), {
    field: 'Number', before: { present: false }, after: { present: true, value: '3' },
  });
  await withMetadataHistory(client, 5, 'merge-metadata', {}, async journal => {
    await journal.captureArchives([file]);
    fs.renameSync(file, path.join(directory, 'moved.cbz'));
  });
  const moved = listMetadataHistory(5).items[0];
  assert.equal(moved.status, 'unverified');
  assert.equal(metadataHistoryDetail(5, moved.id)!.archives[0].afterPresent, null);
});

test('unreadable archives fail before an edit begins and preserve the attempt', async () => {
  const { client } = fixture(6);
  let writes = 0;
  await assert.rejects(withMetadataHistory(client, 6, 'comicinfo-edit', {}, async journal => {
    await journal.captureArchives([path.join(directory, 'missing.cbz')]);
    writes++;
  }), /ENOENT/);
  assert.equal(writes, 0);
  assert.equal(listMetadataHistory(6).items[0].status, 'partial');
});

test('pagination and detail are scoped by both connection and series; invalid cursors fail', async () => {
  const { client } = fixture(7);
  for (let i = 0; i < 23; i++) await withMetadataHistory(client, 7, 'provider-apply', {}, async () => {});
  const first = listMetadataHistory(7);
  assert.equal(first.items.length, 20);
  const second = listMetadataHistory(7, first.nextCursor!);
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(entry => entry.id)).size, 23);
  const id = first.items[0].id;
  assert.equal(metadataHistoryDetail(8, id), null);
  setKavitaConnection({ baseUrl: 'https://another-history.test', apiKey: 'fixture' });
  assert.equal(metadataHistoryDetail(7, id), null);
  assert.deepEqual(listMetadataHistory(7).items, []);
  setKavitaConnection({ baseUrl: 'https://history.test/', apiKey: 'fixture' });
  assert.equal((await api.request('/series/7/metadata-history?cursor=bad')).status, 400);
  assert.equal((await api.request(`/series/8/metadata-history/${id}`)).status, 404);
  assert.equal((await api.request(`/series/7/metadata-history/${id}`)).status, 200);
});

test('restart marks unfinished operations interrupted and leaves before snapshots intact', async () => {
  const entry = listMetadataHistory(7).items[0];
  const before = metadataHistoryDetail(7, entry.id)!.before;
  getDb().update(schema.metadataOperations).set({ status: 'running', afterJson: null, finishedAt: null }).where(eq(schema.metadataOperations.id, entry.id)).run();
  interruptMetadataHistory();
  const interrupted = metadataHistoryDetail(7, entry.id)!;
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.before, before);
  assert.equal(interrupted.after, null);
});

test('migration upgrades existing databases and retention keeps 180 days plus latest 20 per series', () => {
  const sqlite = new Database(':memory:');
  migrateSchema(sqlite);
  sqlite.exec('DROP TABLE metadata_operation_steps; DROP TABLE metadata_operations; DELETE FROM schema_migrations WHERE version=5');
  migrateSchema(sqlite);
  migrateSchema(sqlite);
  const insert = sqlite.prepare(`INSERT INTO metadata_operations
    (id,connection_key,series_id,origin,status,fields_json,desired_json,policy_revision,before_json,created_at,finished_at)
    VALUES (?, 'https://history.test', ?, 'fixture', ?, '[]', '{}', 0, '{}', ?, ?)`);
  for (let i = 0; i < 25; i++) {
    insert.run(`old-${i}`, 1, 'completed', '2020-01-01', '2020-01-01');
    sqlite.prepare('INSERT INTO metadata_operation_steps (operation_id,target,before_json) VALUES (?,?,?)').run(`old-${i}`, 'fixture.cbz', '{}');
  }
  insert.run('active', 1, 'running', '2020-01-01', null);
  insert.run('other-series', 2, 'completed', '2020-01-01', '2020-01-01');
  insert.run('recent', 3, 'completed', '2026-11-15', '2026-11-15');
  pruneMetadataHistory(sqlite, Date.parse('2026-11-16T12:00:00Z'));
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM metadata_operations').get() as { n: number }).n, 23);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM metadata_operation_steps').get() as { n: number }).n, 20);
  assert.ok(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='active'").get());
  sqlite.close();
});
