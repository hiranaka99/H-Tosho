import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Point the DB at a throwaway directory before the db module loads so
// applyToKavita's history writes land in an isolated schema. The dynamic
// imports are deliberate (module-loading boundary): DATA_DIR is a module-level
// const in db/index.js, so static imports would capture the real data dir.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-sync-apply-'));

import type { KavitaClient } from '../src/kavita/client.js';
const { initDb } = await import('../src/db/index.js');
const { applyToKavita } = await import('../src/services/sync.js');
const { DEFAULT_AGGREGATION } = await import('../src/services/settings.js');
initDb();

interface CapturedPush {
  patch: { tags?: string[] };
}

/** Stub client exposing only what applyToKavita touches; captures the pushed payload. */
function stubClient(existingTags: string[]): { client: KavitaClient; captured: CapturedPush } {
  const captured: CapturedPush = {};
  const client = {
    getSeriesMetadata: async () => ({ tags: existingTags.map((title) => ({ id: 0, title })) }),
    updateSeriesMetadata: async (_seriesId: number, patch: { tags?: string[] }) => {
      captured.patch = patch;
    },
  } as unknown as KavitaClient;
  return { client, captured };
}

const metadata: SeriesMetadata = {
  providerId: 'mangadex',
  providerSeriesId: 'md-1',
  title: 'Test Series',
  type: 'MANGA',
  genres: [],
  tags: ['Found family', 'New tag'],
  writers: [],
  artists: [],
  publishers: [],
  imprints: [],
};

describe('applyToKavita tag merging', () => {
  it('pushes existing + provider tags with duplicates dropped', async () => {
    const { client, captured } = stubClient(['Found Family', 'User tag']);
    await applyToKavita(client, 1, metadata, {
      agg: DEFAULT_AGGREGATION,
      fieldConfig: {},
      cover: null,
      title: 'Test Series',
    });

    assert.deepEqual(captured.patch.tags, ['Found Family', 'User tag', 'New tag']);
  });

  it('pushes provider tags as-is when the series has no metadata row yet', async () => {
    const captured: CapturedPush = {};
    const client = {
      getSeriesMetadata: async () => {
        throw new Error('not found');
      },
      updateSeriesMetadata: async (_seriesId: number, patch: { tags?: string[] }) => {
        captured.patch = patch;
      },
    } as unknown as KavitaClient;

    await applyToKavita(client, 2, metadata, {
      agg: DEFAULT_AGGREGATION,
      fieldConfig: {},
      cover: null,
      title: 'Test Series',
    });

    assert.deepEqual(captured.patch.tags, ['Found family', 'New tag']);
  });
});
