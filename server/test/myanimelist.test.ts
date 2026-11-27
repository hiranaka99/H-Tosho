import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { myAnimeListProvider } from "../src/providers/myanimelist.js";
import { autoMatch } from "../src/match/autoMatcher.js";

const originalFetch = globalThis.fetch;
beforeEach(() =>
  myAnimeListProvider.setCredentials({ clientId: "fixture-client-id" })
);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("MAL normalizes search whitespace and preserves valid keywords and result metadata", async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.myanimelist.net");
    assert.equal(url.pathname, "/v2/manga");
    assert.equal(url.searchParams.get("q"), "Sample Title");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("nsfw"), "true");
    assert.ok(url.searchParams.get("fields")?.includes("alternative_titles"));
    assert.equal(
      new Headers(init?.headers).get("X-MAL-CLIENT-ID"),
      "fixture-client-id"
    );
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json({
      data: [
        {
          node: {
            id: 12,
            title: "Sample Title",
            type: "manga",
            main_picture: { large: "https://example.test/cover.jpg" },
          },
        },
      ],
    });
  };
  const results = await myAnimeListProvider.search("  Sample\n\t Title  ");
  assert.equal(results[0].providerSeriesId, "12");
  assert.equal(results[0].title, "Sample Title");
  assert.equal(results[0].coverUrl, "https://example.test/cover.jpg");
});

test("reported long titles use bounded MAL queries while match confidence uses the full title", async () => {
  const titles = [
    "Would You Still Crush on Your Older Childhood Friend Even if She Was a Naughty Girl?",
    "An Extraordinarily Long Anthology Title - The Extended English Subtitle and Collected Chapters",
    "Yuutousei ni Onanie o Miseru Hanashi | A Very Long English Translation of the Original Gallery Title [Ongoing]",
  ];
  for (const title of titles) {
    let calls = 0;
    globalThis.fetch = async (input) => {
      calls++;
      const keyword = new URL(String(input)).searchParams.get("q")!;
      // Reproduce the upstream rejection, rather than accept any request.
      if (Array.from(keyword).length > 64)
        return Response.json(
          { error: "bad_request", message: "invalid q" },
          { status: 400 }
        );
      assert.ok(title.startsWith(keyword));
      return Response.json({
        data: [{ node: { id: 42, title, type: "manga" } }],
      });
    };
    const outcome = await autoMatch(
      { id: 1, name: title },
      {
        providerOrder: ["myanimelist"],
        enabledProviders: ["myanimelist"],
        credentials: { myanimelist: { clientId: "fixture-client-id" } },
        searchAll: true,
      }
    );
    assert.equal(outcome.matched, true);
    assert.equal(
      outcome.best?.score,
      1,
      "score against the original title, not the shortened query"
    );
    assert.deepEqual(outcome.errors, {});
    assert.deepEqual(outcome.searchedProviders, ["myanimelist"]);
    assert.equal(
      calls,
      1,
      "do not submit an invalid query or need a fallback request"
    );
  }
});

test("MAL accepts search boundaries and truncates Unicode without corrupting characters", async () => {
  const queries = [
    "abc",
    "x".repeat(64),
    "x".repeat(63) + "📚 trailing text",
    "日本語".repeat(30),
  ];
  for (const query of queries) {
    globalThis.fetch = async (input) => {
      const keyword = new URL(String(input)).searchParams.get("q")!;
      assert.equal(keyword, Array.from(query).slice(0, 64).join(""));
      assert.ok(Array.from(keyword).length <= 64);
      assert.ok(
        !keyword.includes("\uFFFD"),
        "do not replace a split Unicode character"
      );
      return Response.json({ data: [] });
    };
    assert.deepEqual(await myAnimeListProvider.search(query), []);
  }
});

test("MAL skips empty or too-short keywords without sending invalid requests", async () => {
  globalThis.fetch = async () => {
    throw new Error("No request expected");
  };
  for (const query of ["", " ", "\n\t", "a", "ab", " a ", " a\n "]) {
    assert.deepEqual(await myAnimeListProvider.search(query), []);
  }
});

test("MAL still reports genuine query, authentication and provider errors", async () => {
  for (const [status, message] of [
    [400, "invalid q"],
    [400, "Invalid client id"],
    [401, "invalid_token"],
    [403, "forbidden"],
  ] as const) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ error: "bad_request", message }, { status });
    };
    await assert.rejects(
      myAnimeListProvider.search("Sample title"),
      (error) =>
        error instanceof Error &&
        error.message.includes(`HTTP ${status}`) &&
        error.message.includes(message)
    );
    assert.equal(calls, 1, "do not retry or hide permanent provider failures");
  }
});

test("MAL includes adult results and scores official alternate titles while preserving media types", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("nsfw") !== "true")
      return Response.json({ data: [] });
    return Response.json({
      data: [
        {
          node: {
            id: 42,
            title: "Different romanized title",
            alternative_titles: {
              en: "Gallery title",
              ja: "日本語",
              synonyms: ["Another title"],
            },
            media_type: "doujinshi",
            start_date: "2020-01-01",
          },
        },
      ],
    });
  };
  const result = await autoMatch(
    { id: 1, name: "Gallery title" },
    {
      providerOrder: ["myanimelist"],
      enabledProviders: ["myanimelist"],
      credentials: { myanimelist: { clientId: "fixture-client-id" } },
      searchAll: true,
    }
  );
  assert.equal(result.best?.score, 1);
  assert.equal(result.best?.providerId, "myanimelist");
  assert.equal(result.best?.type, "COMIC");
  assert.equal(result.best?.year, 2020);
});

test("MAL metadata requests official author fields and keeps alternate title choices and publishing status", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.myanimelist.net");
    assert.equal(url.pathname, "/v2/manga/42");
    assert.ok(
      url.searchParams.get("fields")?.includes("authors{first_name,last_name}")
    );
    return Response.json({
      id: 42,
      title: "Original title",
      alternative_titles: { en: "English title", synonyms: ["Other title"] },
      status: "currently_publishing",
      authors: [
        {
          node: { id: 1, first_name: "Myuuto", last_name: "Akatsuki" },
          role: "Story & Art",
        },
      ],
    });
  };
  const result = await myAnimeListProvider.getSeriesMetadata("42");
  assert.deepEqual(result.titleOptions, [
    "Original title",
    "English title",
    "Other title",
  ]);
  assert.deepEqual(result.artists, ["Myuuto Akatsuki"]);
  assert.deepEqual(result.writers, ["Myuuto Akatsuki"]);
  assert.equal(result.status, "ONGOING");
});
