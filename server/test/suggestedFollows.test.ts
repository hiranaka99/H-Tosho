import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-suggested-follows-")
);
const { initDb, getDb, schema } = await import("../src/db/index.js");
const {
  listSuggestedFollows,
  followSuggestedArtist,
  setSuggestedFollowDismissed,
  followedArtists,
  artistWatchQuery,
} = await import("../src/services/suggestedFollows.js");
const { addWatchedSearch, listWatchedSearches } =
  await import("../src/services/watchedSearches.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { api } = await import("../src/routes/api.js");
initDb();

let galleryId = 0;
function downloaded(
  source: "hitomi" | "nhentai",
  artists: string[],
  title = `Gallery ${galleryId + 1}`
) {
  const id = String(++galleryId);
  getDb()
    .insert(schema.galleryTags)
    .values({
      source,
      galleryId: id,
      title,
      artistsJson: JSON.stringify(artists),
      fetchedAt: `2026-11-${String(galleryId).padStart(2, "0")}T00:00:00Z`,
    })
    .run();
  getDb().insert(schema.ownedGalleries).values({ source, galleryId: id }).run();
}
function feedback(value: unknown) {
  getDb()
    .insert(schema.keyValueStore)
    .values({
      key: "recommendation-feedback-v1",
      valueJson: JSON.stringify(value),
    })
    .onConflictDoUpdate({
      target: schema.keyValueStore.key,
      set: { valueJson: JSON.stringify(value) },
    })
    .run();
}
beforeEach(() => {
  for (const table of [
    schema.galleryTags,
    schema.ownedGalleries,
    schema.keyValueStore,
    schema.watchedSearches,
    schema.watchedSearchSeen,
    schema.jobs,
  ])
    getDb().delete(table).run();
  galleryId = 0;
});

test("artists behind several downloads are suggested on the source they came from, strongest first", () => {
  downloaded("hitomi", ["Kirin Kakeru"]);
  downloaded("nhentai", ["kirin kakeru"], "Moth and Flame");
  downloaded("nhentai", ["Kirin Kakeru"]);
  downloaded("hitomi", ["Mana", "Kirin Kakeru"]);
  downloaded("hitomi", ["Mana"]);
  downloaded("hitomi", ["One Off"]);
  downloaded("hitomi", ["n/a"]);
  downloaded("hitomi", ["n/a"]);
  const items = listSuggestedFollows();
  assert.deepEqual(
    items.map((item) => [item.artist, item.downloads]),
    [
      ["Kirin Kakeru", 4],
      ["Mana", 2],
    ]
  );
  assert.equal(items[0].source, "hitomi");
  assert.equal(items[0].query, "artist:kirin_kakeru");
  assert.ok(items[0].titles.includes("Moth and Flame"));
});

test("followed, muted and dismissed artists are not suggested; a liked pick counts double", () => {
  downloaded("hitomi", ["Followed One"]);
  downloaded("hitomi", ["Followed One"]);
  downloaded("nhentai", ["Followed Two"]);
  downloaded("nhentai", ["Followed Two"]);
  downloaded("hitomi", ["Muted"]);
  downloaded("hitomi", ["Muted"]);
  downloaded("hitomi", ["Dismissed"]);
  downloaded("hitomi", ["Dismissed"]);
  addWatchedSearch("hitomi", "artist:followed_one language:english");
  addWatchedSearch("nhentai", 'artist:"followed two" -artist:"muted"');
  feedback({
    liked: [
      {
        source: "hitomi",
        galleryId: "x",
        title: "Liked",
        artists: ["Liked Once"],
        tags: [],
      },
    ],
    mutedArtists: ["muted"],
    mutedTags: [],
  });
  setSuggestedFollowDismissed("Dismissed", true);
  assert.deepEqual(
    listSuggestedFollows().map((item) => [item.artist, item.liked]),
    [["Liked Once", 1]]
  );
  setSuggestedFollowDismissed("dismissed", false);
  assert.ok(
    listSuggestedFollows().some((item) => item.artist === "Dismissed"),
    "Undo brings the suggestion back"
  );
  assert.deepEqual(
    [...followedArtists(['artist:"tanuki$" -artist:skip', "tag:artist"])],
    ["tanuki"],
    "Exclusions never count as follows"
  );
});

test("following creates a named watch once, without checking or downloading anything", async () => {
  downloaded("nhentai", ["Kirin Kakeru"]);
  downloaded("nhentai", ["Kirin Kakeru"]);
  const response = await api.request("/watched-searches/suggestions/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artist: "Kirin Kakeru", source: "nhentai" }),
  });
  assert.equal(response.status, 201);
  const watch = (await response.json()) as {
    query: string;
    displayName: string;
  };
  assert.equal(watch.query, 'artist:"Kirin Kakeru"');
  assert.equal(watch.displayName, "Kirin Kakeru");
  assert.equal(
    followSuggestedArtist("Kirin Kakeru", "nhentai").query,
    watch.query,
    "Following twice reuses the watch"
  );
  assert.equal(listWatchedSearches().length, 1);
  assert.equal(listSuggestedFollows().length, 0);
  assert.equal(jobQueue.list(10).length, 0, "No check or download is queued");
  assert.equal(getDb().select().from(schema.downloadQueue).all().length, 0);
  assert.equal(
    artistWatchQuery("ehentai", "Kirin Kakeru"),
    'artist:"Kirin Kakeru$"'
  );
  const bad = await api.request("/watched-searches/suggestions/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artist: 'a "b"', source: "hitomi" }),
  });
  assert.equal(bad.status, 400);
});
