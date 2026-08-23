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
initDb();

interface CapturedPush {
  patch: { tags?: string[]; name?: string; summary?: string };
}

/** Stub client exposing only what applyToKavita touches; captures the pushed payload. */
function stubClient(existingTags: string[], seriesName = 'Test Series'): { client: KavitaClient; captured: CapturedPush } {
  const captured: CapturedPush = {};
  const client = {
    getSeriesMetadata: async () => ({ tags: existingTags.map((title) => ({ id: 0, title })) }),
    getSeriesById: async () => ({ name: seriesName }),
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
  genres: [],
  tags: ['Found family', 'New tag'],
  writers: [],
  artists: [],
  publishers: [],
};

describe('applyToKavita tag merging', () => {
  it('pushes existing + provider tags with duplicates dropped', async () => {
    const { client, captured } = stubClient(['Found Family', 'User tag']);
    await applyToKavita(client, 1, metadata, {
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
      cover: null,
      title: 'Test Series',
    });

    assert.deepEqual(captured.patch.tags, ['Found family', 'New tag']);
  });
});

describe('applyToKavita field exclusions', () => {
  it('drops excluded fields from the pushed payload', async () => {
    const { client, captured } = stubClient([]);
    await applyToKavita(client, 3, { ...metadata, summary: 'A test.' }, {
      cover: null,
      title: 'Test Series',
      excludedFields: ['title', 'tags'],
    });

    assert.equal(captured.patch?.name, undefined);
    assert.equal(captured.patch?.tags, undefined);
    assert.equal(captured.patch?.summary, 'A test.');
  });
  it('still merges tags when only other fields are excluded', async () => {
    const { client, captured } = stubClient(['Found Family']);
    await applyToKavita(client, 4, metadata, {
      cover: null,
      title: 'Test Series',
      excludedFields: ['title'],
    });

    assert.equal(captured.patch.name, undefined);
    assert.deepEqual(captured.patch.tags, ['Found Family', 'New tag']);
  });
});

describe('applyToKavita name verification', () => {
  it('drops name from pushed and warns when Kavita ignored the rename (v0.9)', async () => {
    const { client, captured } = stubClient([], 'A Fifth of Romance');
    const result = await applyToKavita(client, 1, metadata, {
      cover: null,
      title: 'Test Series',
    });

    // The rename was still sent (0.10+ applies it); the report must not claim it landed.
    assert.equal(captured.patch.name, 'Test Series');
    assert.ok(!result.pushed.includes('name'));
    assert.match(result.warnings[0] ?? '', /series name/);
  });

  it('keeps name in pushed when Kavita applied the rename', async () => {
    const { client } = stubClient([], 'Test Series');
    const result = await applyToKavita(client, 2, metadata, {
      cover: null,
      title: 'Test Series',
    });

    assert.ok(result.pushed.includes('name'));
    assert.deepEqual(result.warnings, []);
  });
});
