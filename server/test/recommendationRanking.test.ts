import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DoujinSearchResult } from '../src/downloader/types.js';
import { rankCandidates, selectRecommendations, workKey, type Candidate } from '../src/services/recommendationRanking.js';

function candidate(id: string, overrides: Partial<DoujinSearchResult> = {}, terms: string[] = []): Candidate {
  return {
    result: { source: 'hitomi', galleryId: id, title: `Work ${id}`, artists: [`Artist ${id}`], tags: [], ...overrides },
    score: 1,
    reasons: terms.map((term) => term.replace(':', ' ')),
    matched: new Set(terms),
  };
}

function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const ids = (items: DoujinSearchResult[]): string[] => items.map((item) => item.galleryId);

test('a distinctive matched tag outranks an equally weighted ubiquitous tag', () => {
  const pool = [
    candidate('common', { tags: ['ubiquitous'] }, ['tag:ubiquitous']),
    candidate('distinctive', { tags: ['ubiquitous', 'distinctive'] }, ['tag:distinctive']),
    ...Array.from({ length: 8 }, (_, i) => candidate(`other-${i}`, { tags: ['ubiquitous'] })),
  ];
  rankCandidates(pool, new Map([['tag:ubiquitous', 12], ['tag:distinctive', 12]]), null);
  assert.ok(pool[1].score > pool[0].score, 'candidate-pool prevalence should reduce the common tag signal');
});

test('ownership frequency is damped and repeated ranking does not accumulate language credit', () => {
  const pool = [
    candidate('small', {}, ['artist:small']),
    candidate('large', {}, ['artist:large']),
    candidate('language', { language: ' English ' }, ['artist:small']),
    candidate('other-source', { source: 'nhentai', language: 'english' }, ['artist:small']),
  ];
  const weights = new Map([['artist:small', 1], ['artist:large', 100]]);
  rankCandidates(pool, weights, 'english');
  assert.ok(pool[1].score > pool[0].score);
  assert.ok(pool[1].score < pool[0].score * 10, 'a hundredfold ownership count should not dominate linearly');
  assert.equal(pool[2].score - pool[0].score, 1.5);
  assert.equal(pool[3].score, pool[0].score, 'existing provider-specific language treatment is preserved');
  const firstScores = pool.map((entry) => entry.score);
  rankCandidates(pool, weights, 'english');
  assert.deepEqual(pool.map((entry) => entry.score), firstScores);
});

test('shared tags and series never impose a hard cap on distinct artists', () => {
  const pool = Array.from({ length: 6 }, (_, i) => candidate(`shared-${i}`, { tags: ['romance'] }, ['tag:romance', 'series:shared']));
  const first = selectRecommendations(pool, 6, seeded(42));
  assert.deepEqual(new Set(ids(first)), new Set(pool.map((entry) => entry.result.galleryId)));
  assert.deepEqual(ids(selectRecommendations(pool, 6, seeded(42))), ids(first), 'same seed and input must yield the same picks');
  assert.ok(new Set(Array.from({ length: 8 }, (_, seed) => ids(selectRecommendations(pool, 6, seeded(seed))).join(','))).size > 1,
    'selection should rotate with the seed rather than always sorting by score');
});

test('tag and series overlap lowers draw priority without forbidding the candidate', () => {
  const previous = { ...candidate('previous', { tags: ['romance'] }, ['series:shared']).result, reasons: ['series shared'] };
  const repeated = candidate('repeated', { tags: ['romance'] }, ['series:shared']);
  const distinct = candidate('distinct');
  // This draw picks the first of two equal weights without overlap, but the
  // second once the first shares both a tag and a series with the prior pass.
  assert.deepEqual(ids(selectRecommendations([repeated, distinct], 1, () => 0.4)), ['repeated']);
  assert.deepEqual(ids(selectRecommendations([repeated, distinct], 1, () => 0.4, [previous])), ['distinct']);
  assert.deepEqual(new Set(ids(selectRecommendations([repeated, distinct], 2, seeded(6), [previous]))), new Set(['repeated', 'distinct']));
});

test('actual artists are capped even when absent from the taste profile, including coartists and earlier passes', () => {
  const pool = [
    candidate('first', { artists: ['Non-Profile Artist', 'Collaborator'] }),
    candidate('same', { artists: [' non-profile artist '] }),
    candidate('collaborator', { artists: ['COLLABORATOR'] }),
    candidate('unrelated', { artists: ['Other'] }),
  ];
  assert.deepEqual(ids(selectRecommendations(pool, 4, () => 0)), ['first', 'unrelated']);
  const previous = { ...pool[0].result, reasons: [] };
  assert.deepEqual(ids(selectRecommendations(pool, 4, seeded(7), [previous])), ['unrelated']);
});

test('missing artists do not create a shared anonymous artist cap and gallery identity still prevents repeats', () => {
  const first = candidate('first', { artists: [] });
  const second = candidate('second', { artists: [' '] });
  assert.deepEqual(new Set(ids(selectRecommendations([first, first, second], 3, seeded(2)))), new Set(['first', 'second']));
  assert.deepEqual(ids(selectRecommendations([first, second], 2, seeded(2), [{ ...first.result, reasons: [] }])), ['second']);
});

test('explicit language editions share work identity only with matching artist sets and positive page counts', () => {
  const english = candidate('en', { title: 'A Work [English]', artists: ['Alpha', 'Beta'], pageCount: 24 }).result;
  const japanese = candidate('jp', { title: 'A Work (Japanese)', artists: [' beta ', 'ALPHA'], pageCount: 24 }).result;
  assert.equal(workKey(english), workKey(japanese));
  assert.equal(workKey(english), workKey({ ...japanese, source: 'nhentai' }));
  assert.notEqual(workKey(english), workKey({ ...japanese, pageCount: 25 }));
  assert.notEqual(workKey(english), workKey({ ...japanese, artists: ['Alpha'] }));
  for (const pageCount of [undefined, 0, -1]) {
    assert.notEqual(workKey({ ...english, pageCount }), workKey({ ...japanese, pageCount }));
  }
  assert.notEqual(workKey({ ...english, artists: [] }), workKey({ ...japanese, artists: [] }));
});

test('unrelated similar titles, volumes and unspecified editions keep their own identity', () => {
  const original = candidate('original', { title: 'A Work [English]', artists: ['Alpha'], pageCount: 24 }).result;
  for (const title of ['A Work', 'A Work 2 [Japanese]', 'A-Work [Japanese]', 'a work [Japanese]', 'A Work [Digital]', 'A Work [English] [Translator]']) {
    assert.notEqual(workKey(original), workKey({ ...original, galleryId: title, title }), `should retain ${title}`);
  }
  const unsuffixed = { ...original, title: 'A Work' };
  assert.notEqual(workKey(unsuffixed), workKey({ ...unsuffixed, galleryId: 'different' }), 'identical generic titles are not reliable work identity');
  const unrelated = candidate('unrelated', { title: 'A Work [Japanese]', artists: ['Beta'], pageCount: 24 });
  assert.deepEqual(new Set(ids(selectRecommendations([{ ...candidate('original'), result: original }, unrelated], 2, seeded(4)))), new Set(['original', 'unrelated']));
});
