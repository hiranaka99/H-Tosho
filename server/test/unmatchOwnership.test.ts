import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import type { KavitaClient } from '../src/kavita/client.js';
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-unmatch-ownership-'));
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { removeSeriesMatch } = await import('../src/services/unmatch.js');
initDb();
beforeEach(() => {
  getDb().delete(schema.seriesMatches).run();
  getDb().delete(schema.syncHistory).run();
  getDb().insert(schema.seriesMatches).values({ kavitaSeriesId: 7, status: 'matched', metadataJson: JSON.stringify({ title: 'Fixture', genres: [], tags: [], writers: [], artists: [], volumeCovers: [{number: 1, url: 'https://cover.test/1'}] }) }).run();
});
function history(action: string, details: unknown) {
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 7, action, detailsJson: JSON.stringify(details) }).run();
}
function client(resets: number[]) {
  return { getSeriesById: async () => ({id: 7, libraryId: 1, name: 'Fixture'}), removeSeriesMetadata: async () => {},
    resetSeriesCover: async () => resets.push(7), resetVolumeCover: async (id: number) => resets.push(id),
    getVolumes: async () => [{id: 71, number: 1}, {id: 72, number: 2}], scanSeries: async () => {},
  } as unknown as KavitaClient;
}
test('an earlier unmatch ends cover ownership, including when the current match excludes covers', async () => {
  history('matched', {coverUpdated: true, volumeCoversUpdated: 1});
  history('unmatched', {});
  history('matched', {coverUpdated: false, volumeCoversUpdated: 0});
  const resets: number[] = [];
  await removeSeriesMatch(client(resets), 7);
  assert.deepEqual(resets, []);
});
test('only successfully applied volume covers are reset, even after another sync excludes covers', async () => {
  history('matched', {volumeCoversUpdated: 1, volumeCoverIds: [71]});
  history('updated', {volumeCoversUpdated: 0, volumeCoverIds: []});
  const resets: number[] = [];
  await removeSeriesMatch(client(resets), 7);
  assert.deepEqual(resets, [71]);
});
test('legacy history limits volume resets to covers in saved provider metadata', async () => {
  history('matched', {volumeCoversUpdated: 1});
  const resets: number[] = [];
  await removeSeriesMatch(client(resets), 7);
  assert.deepEqual(resets, [71]);
});
