import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bestCatalogScore,
  entryTitles,
  isMatureAgeRating,
  type CatalogEntry,
} from '../src/match/mangadexCatalog.js';

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  mangaId: 'manga-1',
  titleEn: undefined,
  originalTitle: undefined,
  altTitles: [],
  ...over,
});

describe('MangaDex adult catalog scoring', () => {
  it('scores exact canonical title matches at 1.0', () => {
    const e = entry({ titleEn: 'At Home Harem Fudeoro Sisters' });
    const best = bestCatalogScore('at home harem fudeoro sisters', e);
    assert.equal(best.score, 1);
    assert.equal(best.title, 'At Home Harem Fudeoro Sisters');
  });

  it('scores containment matches at 0.92', () => {
    const e = entry({ titleEn: 'At Home Harem Fudeoro' });
    const best = bestCatalogScore('Fudeoro', e);
    assert.equal(best.score, 0.92);
  });

  it('is word-order insensitive (canonicalize sorts words)', () => {
    const e = entry({ titleEn: 'Sisters Fudeoro' });
    const best = bestCatalogScore('Fudeoro Sisters', e);
    assert.equal(best.score, 1);
  });

  it('does not treat ASCII fragments of CJK titles as containment', () => {
    // CJK text normalizes away; the surviving "re" fragment must not match
    // inside unrelated words like "harem".
    const e = entry({ titleEn: 'Re:異世界で最強のスキルを生み出せたので、ひたすら無双することにしました。' });
    const best = bestCatalogScore('At Home Harem Fudeoro Sisters', e);
    assert.ok(best.score < 0.45, `expected noise score, got ${best.score}`);
  });
  it('picks the best-scoring variant across en/original/altTitles', () => {
    const e = entry({
      originalTitle: 'Himegoto wa Hitotsu no Uso kara',
      altTitles: ['At Home Harem Fudeoro Sisters'],
    });
    const best = bestCatalogScore('At Home Harem Fudeoro Sisters', e);
    assert.equal(best.score, 1);
    assert.equal(best.title, 'At Home Harem Fudeoro Sisters');
  });

  it('returns 0 for entries without any comparable title', () => {
    const best = bestCatalogScore('Some Series', entry({ mangaId: 'x' }));
    assert.equal(best.score, 0);
    assert.equal(best.title, '');
  });

  it('dedupes and drops empty titles in entryTitles', () => {
    const e = entry({ titleEn: 'Same', originalTitle: 'Same', altTitles: ['Same', '', '   ', 'Other'] });
    assert.deepEqual(entryTitles(e), ['Same', 'Other']);
  });
});

describe('Mature age rating detection', () => {
  it('treats Mature15Plus and above as mature', () => {
    assert.equal(isMatureAgeRating(8), false); // Teen
    assert.equal(isMatureAgeRating(9), true); // Mature15Plus
    assert.equal(isMatureAgeRating(14), true); // X18Plus
  });

  it('treats missing ratings as not mature', () => {
    assert.equal(isMatureAgeRating(undefined), false);
    assert.equal(isMatureAgeRating(null), false);
    assert.equal(isMatureAgeRating(-1), false);
  });
});
