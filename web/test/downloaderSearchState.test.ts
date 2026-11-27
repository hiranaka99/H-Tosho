import { resolveGallerySelection } from "../src/pages/downloader/useGallerySelection.js";
import type { DoujinSearchResult } from "../src/lib/api.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { gallerySearchReducer } from "../src/pages/downloader/searchState.js";
const initial = {
  source: "hitomi",
  query: "draft",
  searchKey: "committed",
  sort: "default",
} as const;
test("editing a search draft preserves the committed query until submit", () => {
  const draft = gallerySearchReducer(initial, {
    type: "input",
    query: "new draft",
  });
  assert.equal(draft.searchKey, "committed");
  assert.equal(
    gallerySearchReducer(draft, { type: "commit", query: " new draft " })
      .searchKey,
    "new draft"
  );
});
test("provider translation and deep links replace all search fields atomically", () => {
  const state = {
    source: "nhentai",
    query: "translated",
    searchKey: null,
    sort: "popular",
  } as const;
  assert.equal(
    gallerySearchReducer(initial, { type: "replace", state }),
    state
  );
});

test("selection keeps click order across pages and retains discovery identity", () => {
  const a: DoujinSearchResult = {
    source: "hitomi",
    galleryId: "a",
    title: "First",
    artists: [],
    tags: [],
  };
  const b: DoujinSearchResult = { ...a, galleryId: "b", title: "Second" };
  const chosen = new Map([
    ["hitomi:b", b],
    ["hitomi:a", a],
  ]);
  const richer = { ...a, artists: ["Artist"] };
  const resolved = resolveGallerySelection(
    chosen,
    [richer],
    [],
    new Set(["hitomi:b"])
  );
  assert.deepEqual(
    resolved.items.map((item) => item.galleryId),
    ["b", "a"]
  );
  assert.deepEqual(resolved.items[1].artists, ["Artist"]);
  assert.deepEqual(resolved.reviewable, [b]);
});
