import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KavitaAgeRating, KavitaPublicationStatus } from '../src/kavita/types.js';
import type { SeriesMetadata } from '../src/providers/types.js';
import { buildSeriesPayload } from '../src/services/sync.js';

describe('Kavita metadata mapping', () => {
  it('maps provider metadata onto Kavita v0.9 fields and enums', () => {
    const metadata: SeriesMetadata = {
      providerId: 'anilist',
      providerSeriesId: '123',
      title: 'Example',
      sortTitle: 'Example, The',
      type: 'MANGA',
      releaseDate: '2024-05-10',
      summary: 'Summary',
      genres: ['Action'],
      tags: ['Found family'],
      writers: ['Writer'],
      artists: ['Artist'],
      publishers: ['Publisher'],
      imprints: ['Imprint'],
      ageRating: KavitaAgeRating.Teen,
      rating: 4,
      language: 'ja',
      status: 'COMPLETED',
      url: 'https://provider.example/series/123',
    };

    assert.deepEqual(
      buildSeriesPayload(
        metadata,
        { mergeTags: true, mergeGenres: true, replaceCover: true, lockCovers: true },
        {},
      ),
      {
        name: 'Example',
        sortName: 'Example, The',
        summary: 'Summary',
        genres: ['Action'],
        tags: ['Found family'],
        writers: ['Writer'],
        artists: ['Artist'],
        publishers: ['Publisher'],
        imprints: ['Imprint'],
        ageRating: KavitaAgeRating.Teen,
        rating: 4,
        releaseYear: 2024,
        language: 'ja',
        publicationStatus: KavitaPublicationStatus.Completed,
        webLinks: 'https://provider.example/series/123',
      },
    );
  });

  it('does not send unknown or invalid enum values to Kavita', () => {
    const metadata: SeriesMetadata = {
      providerId: 'anilist',
      providerSeriesId: '123',
      title: 'Example',
      type: 'MANGA',
      genres: [],
      tags: [],
      writers: [],
      artists: [],
      publishers: [],
      imprints: [],
      ageRating: 99,
      status: 'UNKNOWN',
    };

    const payload = buildSeriesPayload(
      metadata,
      { mergeTags: true, mergeGenres: true, replaceCover: false, lockCovers: false },
      {},
    );
    assert.equal(payload.ageRating, undefined);
    assert.equal(payload.publicationStatus, undefined);
  });
});