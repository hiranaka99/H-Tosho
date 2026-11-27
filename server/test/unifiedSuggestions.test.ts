import assert from "node:assert/strict";
import { test } from "node:test";
import { doujinProviders } from "../src/downloader/providers.js";
import { unifiedSuggestions } from "../src/services/unifiedSuggestions.js";
import { parseCommonQuery } from "../src/services/unifiedQuery.js";

test("unified completion deduplicates shared filters and survives a failed provider", async () => {
  const original = Object.values(doujinProviders).map((p) => p.suggest);
  try {
    doujinProviders.hitomi.suggest = async () => [
      {
        source: "hitomi",
        type: "artist",
        name: "sample_artist",
        filter: "artist:sample_artist",
      },
      { source: "hitomi", type: "tag", name: "unsupported tag" },
    ];
    doujinProviders.nhentai.suggest = async () => [
      { source: "nhentai", type: "artist", name: "Sample Artist", count: 99 },
      { source: "nhentai", type: "group", name: "sample circle" },
    ];
    doujinProviders.ehentai.suggest = async () => {
      throw new Error("unavailable");
    };
    const result = await unifiedSuggestions("sample");
    assert.deepEqual(
      result.map((s) => s.filter),
      ['artist:"sample artist"', 'group:"sample circle"']
    );
    assert.ok(
      result.every(
        (s) => !parseCommonQuery(s.filter!).error && s.count === undefined
      )
    );
    assert.deepEqual(
      (await unifiedSuggestions("artists:sam")).map((s) => s.type),
      ["artist"]
    );
    assert.deepEqual(await unifiedSuggestions("pages:20"), []);
  } finally {
    Object.values(doujinProviders).forEach((p, index) => {
      p.suggest = original[index];
    });
  }
});

test("a stalled provider cannot indefinitely hold up unified suggestions", async () => {
  const original = Object.values(doujinProviders).map((p) => p.suggest);
  try {
    doujinProviders.hitomi.suggest = async () => [
      { source: "hitomi", type: "language", name: "english" },
    ];
    doujinProviders.nhentai.suggest = async () => [];
    doujinProviders.ehentai.suggest = async () => new Promise(() => {});
    assert.equal(
      (await unifiedSuggestions("language:en"))[0].filter,
      'language:"english"'
    );
  } finally {
    Object.values(doujinProviders).forEach((p, index) => {
      p.suggest = original[index];
    });
  }
});
