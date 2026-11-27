import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { anilistProvider } from "../src/providers/anilist.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Minimal Media payload — only the fields getSeriesMetadata consumes. */
const mediaPayload = (media: Record<string, unknown>) =>
  Response.json({ data: { Media: media } });

describe("AniListProvider title options", () => {
  it("offers every known title (main fields + synonyms) as titleOptions, deduped and trimmed (captured manga 142089)", async () => {
    globalThis.fetch = async () =>
      mediaPayload({
        id: 142089,
        // userPreferred mirrors romaji when the caller has no language preference;
        // the community synonym carries a leading space.
        title: {
          romaji: "Kako ni Modotte Akogare no Onee-san wo Netottemita",
          english: null,
          native: "過去に戻って憧れのお姉さんを寝取ってみた",
          userPreferred: "Kako ni Modotte Akogare no Onee-san wo Netottemita",
        },
        format: "MANGA",
        coverImage: {
          extraLarge: "https://img.example/cover.jpg",
          large: null,
        },
        description: "<p>A story.</p>",
        averageScore: 80,
        startDate: { year: 2019, month: 1, day: 1 },
        genres: ["Drama"],
        tags: [{ name: "Harem" }],
        studios: null,
        status: "FINISHED",
        synonyms: [" I Went Back In Time To Do NTR With My Beloved Onee-san"],
      });

    const meta = await anilistProvider.getSeriesMetadata("142089");
    assert.equal(
      meta.title,
      "Kako ni Modotte Akogare no Onee-san wo Netottemita"
    );
    assert.deepEqual(meta.titleOptions, [
      "Kako ni Modotte Akogare no Onee-san wo Netottemita",
      "過去に戻って憧れのお姉さんを寝取ってみた",
      "I Went Back In Time To Do NTR With My Beloved Onee-san",
    ]);
  });

  it("includes the english title and drops null fields without duplicates", async () => {
    globalThis.fetch = async () =>
      mediaPayload({
        id: 1,
        title: {
          romaji: "Romaji Title",
          english: "English Title",
          native: "ローマ字タイトル",
          userPreferred: "Romaji Title",
        },
        format: "MANGA",
        coverImage: {},
        description: "",
        averageScore: 0,
        startDate: null,
        genres: [],
        tags: [],
        studios: null,
        status: "RELEASING",
        synonyms: null,
      });

    const meta = await anilistProvider.getSeriesMetadata("1");
    assert.deepEqual(meta.titleOptions, [
      "Romaji Title",
      "English Title",
      "ローマ字タイトル",
    ]);
  });

  it("keeps the display title in titleOptions when only a native title exists", async () => {
    globalThis.fetch = async () =>
      mediaPayload({
        id: 2,
        title: {
          romaji: null,
          english: null,
          native: "ネイティブのみ",
          userPreferred: null,
        },
        format: "MANGA",
        coverImage: {},
        description: "",
        averageScore: 0,
        startDate: null,
        genres: [],
        tags: [],
        studios: null,
        status: "FINISHED",
        synonyms: ["Another Name"],
      });

    const meta = await anilistProvider.getSeriesMetadata("2");
    assert.equal(meta.title, "ネイティブのみ");
    assert.deepEqual(meta.titleOptions, ["ネイティブのみ", "Another Name"]);
  });
});
