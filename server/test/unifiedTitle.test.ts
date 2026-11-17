import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unifiedTitleKey } from '../src/services/unifiedTitle.js';

const key = (title: string) => unifiedTitleKey(title, ['Sample Artist'], 'english');

test('catalogue prefixes match within the same censorship edition', () => {
  const expected = key('Sample Story 2 [Uncensored]');
  for (const title of [
    '[Sample Artist] Sample Story 2 [English] [Uncensored]',
    '(C103) [Sample Artist] Sample Story 2 [Digital] [Decensored]',
    'Sample Story 2 - Uncensored Version',
    'Sample Story 2 【Decensored】', 'Sample Story 2 [De-censored by Sample Group]',
  ]) assert.equal(key(title), expected, title);
  assert.equal(key('Ｓａｍｐｌｅ Story 2 [English Translation]'), key('Sample Story 2'));
  assert.equal(key('[Sample Artist] Sample Story 2 (Censored)'), key('Sample Story 2 [Censored]'));
});

test('unmarked, censored, and uncensored or decensored editions cannot mix', () => {
  const unmarked = key('Sample Story 2');
  const censored = key('Sample Story 2 [Censored]');
  const uncensored = key('Sample Story 2 [Uncensored]');
  const decensored = key('Sample Story 2 [Decensored]');
  assert.notEqual(unmarked, censored);
  assert.notEqual(unmarked, uncensored);
  assert.notEqual(unmarked, decensored);
  assert.notEqual(censored, uncensored);
  assert.notEqual(censored, decensored);
  assert.equal(uncensored, decensored);
  assert.notEqual(key('Sample Story 2 [Censored] [Uncensored]'), uncensored);
  assert.notEqual(key('Sample Story 2 [Censored] [Uncensored]'), censored);
});

test('author credits do not change edition identity', () => {
  const artistKey = (title: string) => unifiedTitleKey(title, ['mmchair'], 'english');
  for (const title of [
    'Gurabiuaidoru to ecchina koto suru | Doing sexual things with a gravure idol',
    'Ecchi na Omise ni Ittara, Mukashi no Doukyuusei ga Ita Hanashi Sono 8',
    'Yuutousei ni Onanie o Miseru Hanashi',
    'A Bodyguard Without Protection -- Bodyguard ha Mamorenai',
  ]) {
    assert.equal(artistKey(`[MM] ${title} [English]`), artistKey(title), title);
    assert.equal(artistKey(`(C103) [mm] ${title} [Digital]`), artistKey(title), title);
    assert.equal(artistKey(`[MM] ${title} [Decensored]`), artistKey(`${title} [Uncensored]`), title);
    assert.notEqual(artistKey(`[MM] ${title} [Uncensored]`), artistKey(title), title);
    assert.notEqual(artistKey(`[MM] ${title} [Censored]`), artistKey(`${title} [Uncensored]`), title);
  }
  assert.equal(key('[MM] Sample Story 2'), key('Sample Story 2'), 'credit normalization does not depend on artist spelling');
  assert.equal(artistKey('[MM 2] Sample Story 2'), artistKey('Sample Story 2'), 'credit names may contain numbers');
  assert.notEqual(artistKey('Sample Story 2 [MM]'), artistKey('Sample Story 2'), 'only leading credits are removed');
});

test('leading artist, circle and nested credits are independent of length and artist aliases', () => {
  for (const prefix of [
    '[A]', '[MM]', '[An Entirely Unrelated Pen Name]', '[Different Artist]',
    '[40010 1-GO (Shimanto Shisakugata)]', '[Circle [Artist Alias]]',
    '[Long Studio Name (Another Pen Name)] [Another Circle]',
    '(C103) 【全角サークル (別名)】 [Another Alias]',
    '［A Fullwidth Studio Name (Artist)］',
  ]) assert.equal(key(`${prefix} Sample Story 2 [English]`), key('Sample Story 2'), prefix);
  assert.equal(key('[Chapter 2] [An Unrelated Alias] Sample Story'), key('[Chapter 2] Sample Story'));
  assert.equal(key('[Full Color] [An Unrelated Alias] Sample Story'), key('[Full Color] Sample Story'));
  assert.equal(key('[Long Studio Name (Another Pen Name)] [English]'), '', 'credit-only titles cannot identify a work');
  assert.notEqual(key('[Unclosed Credit Sample Story 2'), key('Sample Story 2'));
  assert.notEqual(key('[Credit (Mismatched] Sample Story 2'), key('Sample Story 2'));
});

test('circle credits and bilingual separator punctuation normalize within the same edition', () => {
  const artist = ['shimanto shisakugata'];
  const hitomi = 'Saten-san Onsen Report o Suru Natsu - Saten-san; A Hot Spring Report (decensored)';
  const other = '[40010 1-GO (Shimanto Shisakugata)] Saten-san Onsen Report o Suru Natsu | Saten-san; A Hot Spring Report [English] [Uncensored]';
  assert.equal(unifiedTitleKey(hitomi, artist, 'english'), unifiedTitleKey(other, artist, 'english'));
  assert.notEqual(unifiedTitleKey(hitomi, artist, 'english'), unifiedTitleKey(other.replace(' [Uncensored]', ''), artist, 'english'));
});

test('meaningful titles, chapters, and other editions are preserved', () => {
  for (const title of [
    'Sample Story 3', 'Sample Story 2 [Chapter 1]', 'Sample Story 2 [Full Color]',
    'Sample Story 2 [Rewrite]', 'Sample Story 2 [Translator A]',
    'Sample Story 2 [French]', 'Uncensored Sample Story 2',
    '[Chapter 1] Sample Story 2', '[Part 2] Sample Story 2', '[Vol.2] Sample Story 2',
    '[Full Color] Sample Story 2', '[Rewrite] Sample Story 2', '[French] Sample Story 2',
    '[Translator A] Sample Story 2', '[v2] Sample Story 2', '[2] Sample Story 2',
    '(The Beginning) Sample Story 2',
  ]) assert.notEqual(key(title), key('Sample Story 2'), title);
  assert.notEqual(key('Café'), key('Caf'));
  assert.equal(key('[Uncensored] [English]'), '', 'annotation-only titles cannot identify a work');
});
