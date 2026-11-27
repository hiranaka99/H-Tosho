import assert from "node:assert/strict";
import { test } from "node:test";
import {
  switchProviderSearch,
  translateSearch,
} from "../src/lib/searchTranslation.js";
import { buildTagSearchFragment } from "../src/lib/utils.js";

test("E-Hentai artist and tag links preserve quoted values", () => {
  assert.equal(
    buildTagSearchFragment("mana", "artist", "ehentai"),
    'artist:"mana"'
  );
  assert.equal(
    buildTagSearchFragment("two words", "artist", "ehentai"),
    'artist:"two words"'
  );
  assert.equal(
    buildTagSearchFragment("big breasts", "female", "ehentai"),
    'female:"big breasts"'
  );
  assert.equal(buildTagSearchFragment("keyword", null, "ehentai"), "keyword");
  assert.equal(buildTagSearchFragment("  ", "artist", "ehentai"), "");
});

test("switching to E-Hentai quotes artist names and multi-word shared filters", () => {
  assert.deepEqual(
    translateSearch("artist:mana -group:other_circle", "hitomi", "ehentai"),
    {
      query: 'artist:"mana" -group:"other circle"',
      sort: "default",
      issues: [],
    }
  );
});

test("Hitomi shared fields translate to quoted nHentai fields without quoting ordinary keywords", () => {
  assert.deepEqual(
    translateSearch(
      "portrait artist:sample_name -group:other_group language:japanese",
      "hitomi",
      "nhentai",
      "popular-week"
    ),
    {
      query:
        'portrait artist:"sample name" -group:"other group" language:"japanese"',
      sort: "popular-week",
      issues: [],
    }
  );
});

test("nHentai plural namespaces, spaces and exclusions become valid Hitomi terms", () => {
  assert.deepEqual(
    translateSearch(
      'artists:"Sample Name" -groups:"Other Group" parodies:Example characters:"A B" languages:english categories:manga',
      "nhentai",
      "hitomi"
    ),
    {
      query:
        "artist:sample_name -group:other_group parody:example character:a_b language:english type:manga",
      sort: "default",
      issues: [],
    }
  );
});

test("apostrophes are part of names and do not consume subsequent filters", () => {
  const translated = translateSearch(
    'artist:"O’Brien" -group:"O\'Neil" language:japanese',
    "nhentai",
    "hitomi"
  );
  assert.equal(
    translated.query,
    "artist:o’brien -group:o'neil language:japanese"
  );
  assert.deepEqual(translated.issues, []);
});

test("smart double quotes and exclusion dashes normalize while translating", () => {
  assert.equal(
    translateSearch(
      "artists:“Sample Name” —group:“Other Group”",
      "nhentai",
      "hitomi"
    ).query,
    "artist:sample_name -group:other_group"
  );
});

test("gender scopes retain the excluded tag and explain the difference", () => {
  const translated = translateSearch(
    "-female:full_color male:sample tag:digital",
    "hitomi",
    "nhentai"
  );
  assert.equal(
    translated.query,
    '-tag:"full color" tag:"sample" tag:"digital"'
  );
  assert.equal(translated.issues.length, 2);
  assert.match(translated.issues[0], /without gender scope/);
});

test("nHentai tag filters never guess a Hitomi gender", () => {
  const translated = translateSearch(
    'tag:"landscape" -tags:"full color"',
    "nhentai",
    "hitomi"
  );
  assert.equal(translated.query, "landscape -full -color");
  assert.equal(translated.issues.length, 1);
  assert.match(translated.issues[0], /scope and exact phrase/);
});

test("exact phrases and title fields require review instead of pretending to be exact", () => {
  const translated = translateSearch(
    '"exact phrase" -title:"other phrase"',
    "nhentai",
    "hitomi"
  );
  assert.equal(translated.query, "exact phrase -other -phrase");
  assert.equal(translated.issues.length, 2);
});

test("numeric, date and unknown fields are reported instead of becoming bogus Hitomi fields", () => {
  const translated = translateSearch(
    "artist:sample pages:>20 favorites:>=100 uploaded:<7d unknown:value",
    "nhentai",
    "hitomi"
  );
  assert.equal(translated.query, "artist:sample");
  assert.equal(translated.issues.length, 4);
});

test("unsupported gallery types and catalog-specific IDs are never guessed", () => {
  assert.equal(
    translateSearch(
      "artist:sample -type:imageset type:anime",
      "hitomi",
      "nhentai"
    ).issues.length,
    2
  );
  for (const value of [
    "12345",
    "# 12345",
    "https://nhentai.net/g/12345/",
    "https://hitomi.la/doujinshi/example-12345.html",
    "/galleries/12345.html",
  ]) {
    const result = translateSearch(value, "hitomi", "nhentai");
    assert.equal(result.query, "");
    assert.match(result.issues[0], /cannot be transferred/);
  }
});

test("Hitomi OR is reported as a semantic change", () => {
  const translated = translateSearch(
    "artist:one OR artist:two -group:other",
    "hitomi",
    "nhentai"
  );
  assert.equal(translated.query, 'artist:"one" artist:"two" -group:"other"');
  assert.match(translated.issues[0], /OR/);
});

test("Hitomi inline sort directives become the target sort control", () => {
  assert.deepEqual(
    translateSearch(
      "artist:sample orderby:popular orderbykey:week",
      "hitomi",
      "nhentai"
    ),
    {
      query: 'artist:"sample"',
      sort: "popular-week",
      issues: [],
    }
  );
  const ascending = translateSearch(
    "artist:sample sortby:popular sortbykey:today orderbydirection:asc",
    "hitomi",
    "nhentai"
  );
  assert.equal(ascending.sort, "popular-today");
  assert.match(ascending.issues[0], /ascending/);
});

test("sorts without an exact equivalent reset explicitly instead of guessing a popularity period", () => {
  for (const sort of [
    "popular-year",
    "popular-month",
    "date-published",
    "random",
  ] as const) {
    const translated = translateSearch(
      "artist:sample",
      "hitomi",
      "nhentai",
      sort
    );
    assert.equal(translated.sort, "default");
    assert.match(translated.issues[0], /reset to newest/);
  }
  const translated = translateSearch(
    "artist:sample",
    "nhentai",
    "hitomi",
    "popular"
  );
  assert.equal(translated.sort, "default");
  assert.match(translated.issues[0], /all-time popularity/);
});

test("empty input stays empty and implicit English remains a provider default", () => {
  assert.deepEqual(translateSearch("  ", "hitomi", "nhentai"), {
    query: "",
    sort: "default",
    issues: [],
  });
  assert.equal(
    translateSearch("artist:sample", "hitomi", "nhentai").query,
    'artist:"sample"'
  );
});

test("escaped quotes are retained for nHentai and unrepresentable Hitomi values are reported", () => {
  assert.equal(
    translateSearch('artist:sample_"name"', "hitomi", "nhentai").query,
    'artist:"sample \\"name\\""'
  );
  const translated = translateSearch(
    'artist:"Sample \\"Name\\""',
    "nhentai",
    "hitomi"
  );
  assert.equal(translated.query, "");
  assert.match(translated.issues[0], /cannot represent/);
});

test("unfinished quotes are not silently considered a safe search", () => {
  assert.match(
    translateSearch('artist:"unfinished name', "nhentai", "hitomi").issues[0],
    /unfinished/
  );
});

test("literal phrase text never turns into Hitomi operators or changes the language", () => {
  const translated = translateSearch(
    '"language:japanese" "or" "-excluded" artist:sample',
    "nhentai",
    "hitomi"
  );
  assert.equal(translated.query, "artist:sample");
  assert.equal(translated.issues.length, 4);
});

test("all languages is reported rather than converted to a nonexistent nHentai language", () => {
  const translated = translateSearch(
    "artist:sample language:all",
    "hitomi",
    "nhentai"
  );
  assert.equal(translated.query, 'artist:"sample"');
  assert.match(translated.issues[0], /all-languages/);
});

test("a committed compatible query automatically searches the target", () => {
  const current = {
    query: " artist:sample_name ",
    searchKey: "artist:sample_name",
    sort: "popular-week" as const,
  };
  const result = switchProviderSearch(current, "hitomi", "nhentai");
  assert.deepEqual(result.search, {
    query: 'artist:"sample name"',
    searchKey: 'artist:"sample name"',
    sort: "popular-week",
  });
});

test("unsaved drafts translate but do not start a new search", () => {
  const result = switchProviderSearch(
    { query: "artist:new_name", searchKey: "artist:old_name", sort: "default" },
    "hitomi",
    "nhentai"
  );
  assert.equal(result.search.query, 'artist:"new name"');
  assert.equal(result.search.searchKey, null);
});

test("lossy translations pause automatic searching and unchanged round trips restore the exact input", () => {
  const current = {
    query: 'artists:"Sample Name" pages:>20',
    searchKey: 'artists:"Sample Name" pages:>20',
    sort: "popular" as const,
  };
  const forward = switchProviderSearch(current, "nhentai", "hitomi");
  assert.equal(forward.search.searchKey, null);
  assert.equal(forward.issues.length, 2);
  const back = switchProviderSearch(
    forward.search,
    "hitomi",
    "nhentai",
    forward.link
  );
  assert.deepEqual(back.search, current);
  assert.deepEqual(back.issues, []);
  assert.equal(back.link, null);
});

test("edited destination queries always translate the current query rather than restoring stale saved searches", () => {
  const forward = switchProviderSearch(
    { query: "artist:original", searchKey: null, sort: "default" },
    "hitomi",
    "nhentai"
  );
  const back = switchProviderSearch(
    { ...forward.search, query: 'artists:"New Name"', sort: "popular-week" },
    "nhentai",
    "hitomi",
    forward.link
  );
  assert.deepEqual(back.search, {
    query: "artist:new_name",
    searchKey: null,
    sort: "popular-week",
  });
});
