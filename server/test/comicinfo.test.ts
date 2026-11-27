import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildComicInfoFields,
  generateComicInfoXml,
  parseComicInfo,
} from "../src/downloader/comicinfo.js";
import type { DoujinGallery } from "../src/downloader/types.js";

function gallery(overrides: Partial<DoujinGallery> = {}): DoujinGallery {
  return {
    source: "hitomi",
    galleryId: "1",
    title: "Some Title",
    tags: ["vanilla", "group", "sole female"],
    tagNamespaces: [null, "male", "female"],
    artists: ["alpha"],
    ...overrides,
  } as DoujinGallery;
}

test("Year comes from the upload date, not tag grep", () => {
  const withDate = buildComicInfoFields(
    gallery({ uploadedAt: "2024-03-05T12:00:00-05:00" })
  );
  assert.equal(withDate.Year, "2024");
  // A 4-digit-looking tag must not leak into Year when no date exists.
  const noDate = buildComicInfoFields(
    gallery({ uploadedAt: undefined, tags: ["2024 pages"] })
  );
  assert.equal(noDate.Year, "");
});

test("Language comes from the language field, not a language: tag prefix", () => {
  const fields = buildComicInfoFields(
    gallery({
      language: "english",
      tags: ["language:japanese", "vanilla"],
      tagNamespaces: [null, null],
    })
  );
  assert.equal(fields.Language, "english");
  assert.equal(buildComicInfoFields(gallery({})).Language, "");
});

test("Characters, Publisher (circles) and SeriesGroup (parodies) map through", () => {
  const fields = buildComicInfoFields(
    gallery({
      characters: [" CHARACTER a", "character a", "Char B"],
      groups: ["Some Circle"],
      parodies: ["Blue Archive", "Original"],
      series: "Blue Archive",
    })
  );
  assert.equal(fields.Characters, "CHARACTER a, Char B");
  assert.equal(fields.Publisher, "Some Circle");
  assert.equal(fields.SeriesGroup, "Blue Archive, Original");
  assert.equal(fields.Series, "Blue Archive");
});

test("Genre prefers the gendered tags; an explicit genres list wins", () => {
  const fromTags = buildComicInfoFields(gallery({}));
  assert.equal(fromTags.Genre, "group, sole female");
  const explicit = buildComicInfoFields(gallery({ genres: ["Vanilla"] }));
  assert.equal(explicit.Genre, "Vanilla");
});

test("generateComicInfoXml emits the new roles and they survive a round-trip", () => {
  const xml = generateComicInfoXml(
    gallery({
      characters: ["Char B"],
      groups: ["Some Circle"],
      parodies: ["Blue Archive"],
      language: "english",
      uploadedAt: "2024-03-05T12:00:00Z",
      url: "https://hitomi.la/galleries/1.html",
    }),
    { seriesName: "Kavita Series", number: "3" }
  );
  assert.match(xml, /<Characters><!\[CDATA\[Char B\]\]><\/Characters>/);
  assert.match(xml, /<Publisher><!\[CDATA\[Some Circle\]\]><\/Publisher>/);
  assert.match(xml, /<SeriesGroup><!\[CDATA\[Blue Archive\]\]><\/SeriesGroup>/);
  assert.match(xml, /<Genre><!\[CDATA\[group, sole female\]\]><\/Genre>/);
  assert.match(xml, /<Number>3<\/Number>/);

  const doc = parseComicInfo(xml);
  assert.equal(doc.fields["Characters"], "Char B");
  assert.equal(doc.fields["Publisher"], "Some Circle");
  assert.equal(doc.fields["SeriesGroup"], "Blue Archive");
  assert.ok(doc.order.indexOf("Characters") < doc.order.indexOf("Publisher"));
});
