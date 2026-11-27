import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldEnableIdentify } from "../src/lib/identifyGating.js";
import {
  LIBRARY_MATCH_CHUNK,
  pruneLibraryMatchCache,
  selectUncheckedGalleries,
  type LibraryMatchCacheEntry,
} from "../src/lib/libraryMatchBatcher.js";
import { createdAgoIntervalMs, getJobHaystack } from "../src/lib/jobsPerf.js";
import type {
  DoujinSearchResult,
  DuplicateReport,
  Job,
} from "../src/lib/api.js";

function makeGallery(id: number): DoujinSearchResult {
  return {
    source: "hitomi",
    galleryId: String(id),
    title: `Gallery ${id}`,
    tags: [],
    artists: [],
  };
}

function makeReport(id: number): DuplicateReport {
  return {
    source: "hitomi",
    galleryId: String(id),
    title: `Gallery ${id}`,
    matches: [],
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    type: "match-library",
    payload: {},
    status: "completed",
    progressCurrent: 0,
    progressTotal: 0,
    errorMessage: null,
    createdAt: "2026-01-01 00:00:00",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  } as Job;
}

test("shouldEnableIdentify gates autoReview and initialCandidate flows until candidates are requested", () => {
  assert.equal(
    shouldEnableIdentify({
      browseArtists: true,
      selected: false,
      hasInitialCandidate: false,
      autoReview: false,
      hasMatch: false,
      currentError: false,
      autoReviewDone: false,
    }),
    false
  );

  // initialCandidate from Home stays gated while reviewing that candidate, then enables on Back to matches.
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: true,
      hasInitialCandidate: true,
      autoReview: false,
      hasMatch: false,
      currentError: false,
      autoReviewDone: false,
    }),
    false
  );
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: false,
      hasInitialCandidate: true,
      autoReview: false,
      hasMatch: false,
      currentError: false,
      autoReviewDone: false,
    }),
    true
  );

  // autoReview + hasMatch avoids an initial /identify call before series metadata arrives,
  // stays disabled while viewing the matched candidate, and fetches once user goes back to matches.
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: false,
      hasInitialCandidate: false,
      autoReview: true,
      hasMatch: true,
      currentError: false,
      autoReviewDone: false,
    }),
    false
  );
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: true,
      hasInitialCandidate: false,
      autoReview: true,
      hasMatch: true,
      currentError: false,
      autoReviewDone: true,
    }),
    false
  );
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: false,
      hasInitialCandidate: false,
      autoReview: true,
      hasMatch: true,
      currentError: false,
      autoReviewDone: true,
    }),
    true
  );

  // If current series metadata failed to load, do not block /identify indefinitely.
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: false,
      hasInitialCandidate: false,
      autoReview: true,
      hasMatch: true,
      currentError: true,
      autoReviewDone: false,
    }),
    true
  );

  // Unmatched series with autoReview still fetches candidates immediately.
  assert.equal(
    shouldEnableIdentify({
      browseArtists: false,
      selected: false,
      hasInitialCandidate: false,
      autoReview: true,
      hasMatch: false,
      currentError: false,
      autoReviewDone: false,
    }),
    true
  );
});

test("selectUncheckedGalleries deduplicates, respects TTL, and chunks to LIBRARY_MATCH_CHUNK", () => {
  const now = 1_000_000;
  const cache = new Map<string, LibraryMatchCacheEntry>([
    ["hitomi:1", { report: null, fetchedAt: now - 5_000 }],
    ["hitomi:2", { report: makeReport(2), fetchedAt: now - 30_000 }],
  ]);
  const items = [
    makeGallery(1),
    makeGallery(1),
    makeGallery(2),
    makeGallery(3),
    makeGallery(3),
  ];
  const chunks = selectUncheckedGalleries(items, cache, now, 30_000);
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    chunks[0].map((g) => g.galleryId),
    ["2", "3"]
  );

  const many = Array.from({ length: LIBRARY_MATCH_CHUNK + 5 }, (_, i) =>
    makeGallery(i + 10)
  );
  const batched = selectUncheckedGalleries(many, new Map(), now, 60_000);
  assert.equal(batched.length, 2);
  assert.equal(batched[0].length, LIBRARY_MATCH_CHUNK);
  assert.equal(batched[1].length, 5);
});

test("pruneLibraryMatchCache evicts oldest entries first", () => {
  const cache = new Map<string, LibraryMatchCacheEntry>([
    ["hitomi:1", { report: null, fetchedAt: 10 }],
    ["hitomi:2", { report: null, fetchedAt: 20 }],
    ["hitomi:3", { report: null, fetchedAt: 30 }],
  ]);
  pruneLibraryMatchCache(cache, 2);
  assert.deepEqual([...cache.keys()], ["hitomi:2", "hitomi:3"]);
});

test("createdAgoIntervalMs returns age-tiered clock cadence or null for static dates", () => {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  assert.equal(
    createdAgoIntervalMs(new Date(now - 20_000).toISOString(), now),
    10_000
  );
  assert.equal(
    createdAgoIntervalMs(new Date(now - 10 * 60_000).toISOString(), now),
    60_000
  );
  assert.equal(
    createdAgoIntervalMs(new Date(now - 5 * 3_600_000).toISOString(), now),
    300_000
  );
  assert.equal(
    createdAgoIntervalMs(new Date(now - 2 * 86_400_000).toISOString(), now),
    null
  );
  assert.equal(createdAgoIntervalMs(null, now), null);
  assert.equal(createdAgoIntervalMs("not-a-date", now), null);
});

test("getJobHaystack memoizes per Job object reference and recomputes for a new reference", () => {
  let calls = 0;
  const builder = (job: Job) => {
    calls++;
    return `Job ${job.id} MixedCase`;
  };
  const j1 = makeJob({ id: 42 });
  assert.equal(getJobHaystack(j1, builder), "job 42 mixedcase");
  assert.equal(getJobHaystack(j1, builder), "job 42 mixedcase");
  assert.equal(calls, 1);

  const j2 = makeJob({ id: 42 });
  assert.equal(getJobHaystack(j2, builder), "job 42 mixedcase");
  assert.equal(calls, 2);
});
