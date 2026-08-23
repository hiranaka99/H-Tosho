import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Point the DB at a throwaway directory before the sync module loads (it
// imports db/index.js at module level); checkAlignment itself is pure.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-alignment-'));

import type { SeriesMetadata } from '../src/providers/types.js';
import type { KavitaSeriesMetadataDto } from '../src/kavita/types.js';
import { KavitaPublicationStatus } from '../src/kavita/types.js';
const { checkAlignment } = await import('../src/services/sync.js');

/** Fully-populated provider metadata — every field the dialog can sync. */
const meta: SeriesMetadata = {
  providerId: 'mangadex',
  providerSeriesId: 'md-1',
  title: 'Test Series',
  sortTitle: 'test series',
  summary: 'A story about found family.',
  genres: ['Romance', 'Comedy'],
  tags: ['Found family', 'New tag'],
  writers: ['Author One'],
  artists: ['Artist One'],
  year: 2015,
  language: 'English',
  status: 'COMPLETED',
  url: 'https://mangadex.org/series/md-1',
};

/** Kavita's side of a fully aligned series. */
const alignedKavita = {
  name: 'test series',
  sortName: 'TEST SERIES',
  metadata: {
    id: 1,
    seriesId: 10,
    summary: 'A story about found family.',
    genres: [
      { id: 2, title: 'Comedy' },
      { id: 1, title: 'Romance' },
    ],
    tags: [
      { id: 3, title: 'Found family' },
      { id: 4, title: 'New tag' },
      { id: 5, title: 'User extra' },
    ],
    writers: [{ id: 6, name: 'Author One' }],
    coverArtists: null,
    publishers: null,
    characters: null,
    pencillers: [{ id: 7, name: 'Artist One' }],
    inkers: null,
    imprints: null,
    colorists: null,
    letterers: null,
    editors: null,
    translators: null,
    teams: null,
    locations: null,
    ageRating: 0,
    releaseYear: 2015,
    language: 'english',
    maxCount: 0,
    totalCount: 0,
    publicationStatus: KavitaPublicationStatus.Completed,
    webLinks: 'https://mangadex.org/series/md-1',
    languageLocked: false,
    summaryLocked: false,
    ageRatingLocked: false,
    publicationStatusLocked: false,
    genresLocked: false,
    tagsLocked: false,
    writerLocked: false,
  } as KavitaSeriesMetadataDto,
};

describe('checkAlignment', () => {
  it('reports aligned when every supplied field matches (case/order-insensitive)', () => {
    const result = checkAlignment(alignedKavita, meta);
    assert.deepEqual(result.mismatched, []);
    assert.equal(result.aligned, true);
  });

  it('treats order-only genre differences as aligned', () => {
    const kavita = {
      ...alignedKavita,
      metadata: { ...alignedKavita.metadata, genres: [{ id: 1, title: 'Romance' }, { id: 2, title: 'Comedy' }] } as KavitaSeriesMetadataDto,
    };
    const result = checkAlignment(kavita, meta);
    assert.equal(result.mismatched.includes('genres'), false);
    assert.equal(result.aligned, true);
  });

  it('treats apostrophe placement differences in list items as aligned', () => {
    const kavita = {
      ...alignedKavita,
      metadata: {
        ...alignedKavita.metadata,
        genres: [
          { id: 2, title: 'Comedy' },
          { id: 1, title: 'Romance' },
          { id: 3, title: "Girl's Love" },
        ],
      } as KavitaSeriesMetadataDto,
    };
    const result = checkAlignment(kavita, { ...meta, genres: ['Romance', 'Comedy', "Girls' Love"] });
    assert.equal(result.mismatched.includes('genres'), false);
    assert.equal(result.aligned, true);
  });

  it('flags a missing provider tag (tags use subset semantics)', () => {
    const kavita = {
      ...alignedKavita,
      metadata: { ...alignedKavita.metadata, tags: [{ id: 3, title: 'Found family' }] } as KavitaSeriesMetadataDto,
    };
    const result = checkAlignment(kavita, meta);
    assert.deepEqual(result.mismatched, ['tags']);
    assert.equal(result.aligned, false);
  });

  it('flags summary drift', () => {
    const kavita = { ...alignedKavita, metadata: { ...alignedKavita.metadata, summary: 'An older description.' } as KavitaSeriesMetadataDto };
    const result = checkAlignment(kavita, meta);
    assert.deepEqual(result.mismatched, ['summary']);
  });

  it('ignores whitespace and case in scalar fields', () => {
    const kavita = {
      ...alignedKavita,
      name: '  Test   Series ',
      metadata: { ...alignedKavita.metadata, summary: 'a story about found family.' } as KavitaSeriesMetadataDto,
    };
    const result = checkAlignment(kavita, meta);
    assert.deepEqual(result.mismatched, []);
    assert.equal(result.aligned, true);
  });

  it('maps provider artists to Kavita pencillers and writers to writers', () => {
    const kavita = {
      ...alignedKavita,
      metadata: {
        ...alignedKavita.metadata,
        // Writers hold the artist name and pencillers hold the writer — swapped.
        writers: [{ id: 7, name: 'Artist One' }],
        pencillers: [{ id: 6, name: 'Author One' }],
      } as KavitaSeriesMetadataDto,
    };
    const result = checkAlignment(kavita, meta);
    assert.deepEqual(result.mismatched.sort(), ['artists', 'writers']);
  });

  it('skips fields the provider does not supply', () => {
    const sparse: SeriesMetadata = {
      providerId: 'mangadex',
      providerSeriesId: 'md-2',
      title: 'Sparse Series',
      genres: [],
      tags: [],
      writers: [],
      artists: [],
    };
    // Kavita carries stale values in fields the provider leaves empty — they are not compared.
    const kavita = {
      name: 'Sparse Series',
      sortName: 'whatever',
      metadata: { ...alignedKavita.metadata, summary: 'old text', releaseYear: 1999 } as KavitaSeriesMetadataDto,
    };
    const result = checkAlignment(kavita, sparse);
    assert.deepEqual(result.mismatched, []);
    assert.equal(result.aligned, true);
  });

  it('compares release year numerically and flags mismatches', () => {
    const kavita = { ...alignedKavita, metadata: { ...alignedKavita.metadata, releaseYear: 2016 } as KavitaSeriesMetadataDto };
    const result = checkAlignment(kavita, meta);
    assert.deepEqual(result.mismatched, ['releaseDate']);
  });

  it('flags a missing sort title when the provider supplies one', () => {
    const kavita = { ...alignedKavita, sortName: null };
    const result = checkAlignment(kavita, meta);
    assert.deepEqual(result.mismatched, ['sortTitle']);
  });

  it('handles a series with no metadata row yet as unaligned', () => {
    const result = checkAlignment({ name: 'Test Series', sortName: null, metadata: null }, meta);
    assert.equal(result.aligned, false);
    assert.ok(result.mismatched.length > 0);
  });
});
