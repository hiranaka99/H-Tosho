import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestBatchKey, nextDigestOccurrence, resolvedTimezone, validDigestTime, validTimezone } from '../src/services/followingClock.js';

test('digest settings accept HH:mm and named IANA zones, reject offsets and malformed values', () => {
  for (const time of ['00:00', '09:00', '23:59']) assert.equal(validDigestTime(time), true);
  for (const time of ['9:00', '24:00', '12:60', '', null, 900]) assert.equal(validDigestTime(time), false);
  for (const zone of ['UTC', 'America/New_York', 'Europe/Paris', 'Australia/Lord_Howe', 'Pacific/Apia']) assert.equal(validTimezone(zone), true);
  for (const zone of ['+02:00', '-05:00', 'Mars/Olympus', '', null]) assert.equal(validTimezone(zone), false);
  assert.ok(validTimezone(resolvedTimezone().timezone));
});
test('spring DST gaps shift forward by the gap rather than skipping an entire daily digest', () => {
  assert.equal(nextDigestOccurrence('02:30', 'America/New_York', Date.parse('2026-03-08T06:00:00Z')), '2026-03-08T07:30:00.000Z');
  assert.equal(nextDigestOccurrence('02:30', 'Europe/Paris', Date.parse('2026-03-29T00:00:00Z')), '2026-03-29T01:30:00.000Z');
  assert.equal(nextDigestOccurrence('02:15', 'Australia/Lord_Howe', Date.parse('2026-10-03T12:00:00Z')), '2026-10-03T15:45:00.000Z');
});
test('repeated DST hours choose the earlier occurrence and never the second occurrence after cutoff', () => {
  assert.equal(nextDigestOccurrence('01:30', 'America/New_York', Date.parse('2026-11-01T04:00:00Z')), '2026-11-01T05:30:00.000Z');
  assert.equal(nextDigestOccurrence('01:30', 'America/New_York', Date.parse('2026-11-01T05:45:00Z')), '2026-11-02T06:30:00.000Z');
  assert.equal(nextDigestOccurrence('01:45', 'Australia/Lord_Howe', Date.parse('2026-04-04T12:00:00Z')), '2026-04-04T14:45:00.000Z');
});
test('a completely skipped local date shifts to the first valid compatible occurrence', () => {
  assert.equal(nextDigestOccurrence('09:00', 'Pacific/Apia', Date.parse('2011-12-29T20:00:00Z')), '2011-12-30T19:00:00.000Z');
});
test('cutoff is strictly future, leap day/calendar transition and timezone changes use local dates', () => {
  assert.equal(nextDigestOccurrence('09:00', 'UTC', Date.parse('2028-02-29T09:00:00Z')), '2028-03-01T09:00:00.000Z');
  assert.equal(nextDigestOccurrence('09:00', 'Asia/Tokyo', Date.parse('2026-11-16T01:00:00Z')), '2026-11-17T00:00:00.000Z');
  assert.equal(digestBatchKey('America/Los_Angeles', Date.parse('2026-11-17T01:00:00Z')), 'America/Los_Angeles|2026-11-16');
  assert.equal(digestBatchKey('Asia/Tokyo', Date.parse('2026-11-17T01:00:00Z')), 'Asia/Tokyo|2026-11-17');
  assert.equal(digestBatchKey('America/New_York', Date.parse('2026-11-01T05:30:00Z')), digestBatchKey('America/New_York', Date.parse('2026-11-01T06:30:00Z')));
});
