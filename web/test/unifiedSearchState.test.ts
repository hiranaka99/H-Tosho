import assert from "node:assert/strict";
import { test } from "node:test";
import { reducer } from "../src/pages/downloader/useUnifiedSearch.js";

type State = Parameters<typeof reducer>[0];

const idle: State = {
  draft: 'artist:"mana"',
  committed: null,
  status: "idle",
  entries: [],
  cursor: null,
  hasMore: false,
  loadedUniqueCount: 0,
  totalUnique: null,
  providers: [],
  error: null,
  retrying: null,
};

test("an aborted search that nothing replaced returns to idle instead of loading forever", () => {
  const searching = reducer(idle, { type: "start", query: 'artist:"mana"' });
  assert.equal(searching.status, "searching");
  const cancelled = reducer(searching, { type: "cancel" });
  assert.equal(cancelled.status, "idle");
  assert.equal(
    cancelled.committed,
    'artist:"mana"',
    "the query is kept so the restored search can start again"
  );
  assert.equal(cancelled.error, null);
});

test("cancelling a retry or load-more keeps the delivered results", () => {
  const loaded = {
    ...idle,
    committed: "x",
    entries: [{ entryId: "e1" } as State["entries"][number]],
    cursor: "c1",
    hasMore: true,
  };
  const retrying = reducer(loaded, { type: "retry", source: "nhentai" });
  const cancelled = reducer(retrying, { type: "cancel" });
  assert.equal(cancelled.status, "idle");
  assert.equal(cancelled.retrying, null);
  assert.equal(cancelled.entries.length, 1);
  assert.equal(cancelled.cursor, "c1");
});

type Entry = State["entries"][number];
const card = (entryId: string, sources: string[]): Entry => ({
  entryId,
  primary: { source: sources[0] } as Entry["primary"],
  variants: sources.map((source, i) => ({
    source,
    galleryId: `${entryId}-${i}`,
  })) as Entry["variants"],
});
const providers = (nhentai: "searching" | "success") =>
  [
    { source: "hitomi", status: "success", retryable: false },
    { source: "nhentai", status: nhentai, retryable: false },
  ] as State["providers"];

test("streamed provider results appear while the search keeps running, and the final page does not duplicate them", () => {
  const searching = reducer(idle, { type: "start", query: "x" });
  const hitomi = reducer(searching, {
    type: "progress",
    items: [card("e1", ["hitomi"]), card("e2", ["hitomi"])],
    updates: [],
    loadedUniqueCount: 2,
    providers: providers("searching"),
  });
  assert.equal(hitomi.status, "searching", "still searching the other sources");
  assert.deepEqual(
    hitomi.entries.map((e) => e.entryId),
    ["e1", "e2"]
  );
  assert.equal(hitomi.providers[1].status, "searching");

  const grown = card("e1", ["hitomi", "nhentai"]);
  const nhentai = reducer(hitomi, {
    type: "progress",
    items: [card("e3", ["nhentai"])],
    updates: [grown],
    loadedUniqueCount: 3,
    providers: providers("success"),
  });
  assert.deepEqual(
    nhentai.entries.map((e) => e.entryId),
    ["e1", "e2", "e3"]
  );
  assert.equal(
    nhentai.entries[0].variants.length,
    2,
    "a matching edition joins the card already shown"
  );

  const done = reducer(nhentai, {
    type: "page",
    items: [
      grown,
      card("e2", ["hitomi"]),
      card("e3", ["nhentai"]),
      card("e4", ["hitomi"]),
    ],
    updates: [],
    cursor: "c1",
    hasMore: true,
    loadedUniqueCount: 4,
    totalUnique: null,
    providers: providers("success"),
  });
  assert.equal(done.status, "idle");
  assert.deepEqual(
    done.entries.map((e) => e.entryId),
    ["e1", "e2", "e3", "e4"],
    "cards keep their place; only new ones are appended"
  );
  assert.equal(done.entries[0].variants.length, 2);
});

test("late progress from a finished or replaced search is ignored", () => {
  const settled = {
    ...idle,
    committed: "x",
    entries: [card("e1", ["hitomi"])],
  };
  const after = reducer(settled, {
    type: "progress",
    items: [card("e9", ["nhentai"])],
    updates: [],
    loadedUniqueCount: 9,
    providers: [],
  });
  assert.equal(after, settled);
});
