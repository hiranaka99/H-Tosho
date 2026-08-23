import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

// Point the DB at a throwaway directory before the db module loads so
// resolveCatalogCover's coverFile persistence lands in an isolated schema.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-catalog-cover-'));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { initDb } = await import('../src/db/index.js');
const { resolveCatalogCover } = await import('../src/match/mangadexCatalog.js');
initDb();

interface CoverFixture {
  fileName: string;
  volume?: number | string | null;
  locale?: string;
  updatedAt?: string;
}

function stubCoverCollection(covers: CoverFixture[]): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (!url.startsWith('https://api.mangadex.org/cover?')) throw new Error(`Unexpected fetch: ${url}`);
    return Response.json({ data: covers.map((c) => ({ attributes: c })) });
  }) as typeof fetch;
}

describe('resolveCatalogCover', () => {
  it('prefers a series-level cover over volume covers', async () => {
    stubCoverCollection([
      { fileName: 'series.png', volume: null, updatedAt: '2025-01-01' },
      { fileName: 'vol1.png', volume: '1', locale: 'en', updatedAt: '2025-06-01' },
    ]);

    const url = await resolveCatalogCover('manga-x');
    assert.equal(url, 'https://uploads.mangadex.org/covers/manga-x/series.png');
  });

  it('falls back to the lowest volume cover when no series-level cover exists', async () => {
    stubCoverCollection([
      { fileName: 'vol3-en.png', volume: '3', locale: 'en', updatedAt: '2025-06-01' },
      { fileName: 'vol1-ja.png', volume: '1', locale: 'ja', updatedAt: '2025-01-01' },
    ]);

    const url = await resolveCatalogCover('manga-y');
    assert.equal(url, 'https://uploads.mangadex.org/covers/manga-y/vol1-ja.png');
  });

  it('picks the preferred locale and newest re-upload within the same volume', async () => {
    stubCoverCollection([
      { fileName: 'vol1-en-old.png', volume: '1', locale: 'en', updatedAt: '2025-01-01' },
      { fileName: 'vol1-ja-new.png', volume: '1', locale: 'ja', updatedAt: '2025-06-01' },
      { fileName: 'vol1-en-new.png', volume: '1', locale: 'en', updatedAt: '2025-03-01' },
    ]);

    const url = await resolveCatalogCover('manga-z');
    assert.equal(url, 'https://uploads.mangadex.org/covers/manga-z/vol1-en-new.png');
  });

  it('returns null when the title has no covers', async () => {
    stubCoverCollection([]);

    const url = await resolveCatalogCover('manga-empty');
    assert.equal(url, null);
  });
});
