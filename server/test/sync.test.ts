import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KavitaPublicationStatus } from '../src/kavita/types.js';
import type { SeriesMetadata } from '../src/providers/types.js';
import { buildSeriesPayload, matchVolumeCovers, mergeTagLists } from '../src/services/sync.js';

describe('Kavita metadata mapping', () => {
  it('maps provider metadata onto Kavita v0.9 fields and enums', () => {
    const metadata: SeriesMetadata = {
      providerId: 'anilist',
      providerSeriesId: '123',
      title: 'Example',
      releaseDate: '2024-05-10',
      summary: 'Summary',
      genres: ['Action'],
      tags: ['Found family'],
      writers: ['Writer'],
      artists: ['Artist'],
      language: 'ja',
      status: 'COMPLETED',
      url: 'https://provider.example/series/123',
    };

    assert.deepEqual(
      buildSeriesPayload(metadata),
      {
        name: 'Example',
        summary: 'Summary',
        genres: ['Action'],
        tags: ['Found family'],
        writers: ['Writer'],
        artists: ['Artist'],
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
      genres: [],
      tags: [],
      writers: [],
      artists: [],
      status: 'UNKNOWN',
    };

    const payload = buildSeriesPayload(metadata);
    assert.equal(payload.publicationStatus, undefined);
  });
});

describe('matchVolumeCovers', () => {
  it('pairs provider covers with Kavita volumes by volume number', () => {
    const volumes = [
      { id: 11, name: 'Volume 1', minNumber: 1, maxNumber: 1, number: 1 },
      { id: 12, name: 'Volume 2', minNumber: 2, maxNumber: 2, number: 2 },
      { id: 13, name: 'Unnumbered', minNumber: undefined, maxNumber: undefined },
    ];
    const covers = [
      { number: 2, url: 'https://cdn.example/vol2.jpg' },
      { number: 1, url: 'https://cdn.example/vol1.jpg' },
      { number: 9, url: 'https://cdn.example/vol9.jpg' },
    ];

    assert.deepEqual(matchVolumeCovers(volumes, covers), [
      { volumeId: 12, number: 2, url: 'https://cdn.example/vol2.jpg' },
      { volumeId: 11, number: 1, url: 'https://cdn.example/vol1.jpg' },
    ]);
  });

  it('skips volumes without a usable number and unmatched covers', () => {
    const volumes = [{ id: 21, name: null, minNumber: undefined, maxNumber: undefined }];
    assert.deepEqual(matchVolumeCovers(volumes, [{ number: 3, url: 'https://cdn.example/vol3.jpg' }]), []);
  });

  it('assigns each Kavita volume at most one cover', () => {
    const volumes = [{ id: 31, name: 'Volume 1', minNumber: 1, maxNumber: 1, number: 1 }];
    const covers = [
      { number: 1, url: 'https://cdn.example/vol1-en.jpg' },
      { number: 1, url: 'https://cdn.example/vol1-ja.jpg' },
    ];
    assert.deepEqual(matchVolumeCovers(volumes, covers), [
      { volumeId: 31, number: 1, url: 'https://cdn.example/vol1-en.jpg' },
    ]);
  });
});

describe('mergeTagLists', () => {
  it('keeps existing tags and appends new provider tags', () => {
    assert.deepEqual(mergeTagLists(['User tag'], ['Provider tag']), ['User tag', 'Provider tag']);
  });

  it('drops duplicates case-insensitively, keeping the existing spelling', () => {
    assert.deepEqual(mergeTagLists(['Found Family', 'Solo'], ['found family', 'solo', 'New']), [
      'Found Family',
      'Solo',
      'New',
    ]);
  });

  it('dedupes within the incoming list and drops blank entries', () => {
    assert.deepEqual(mergeTagLists([], ['  ', '', 'Tag', 'tag']), ['Tag']);
  });

  it('returns a new list without mutating inputs', () => {
    const existing = ['A'];
    const incoming = ['B'];
    mergeTagLists(existing, incoming);
    assert.deepEqual(existing, ['A']);
    assert.deepEqual(incoming, ['B']);
  });
});