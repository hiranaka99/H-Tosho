import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const mangaDexArtist = "9abe212d-e010-413d-b0de-8c14b96c19e8";
const mangaDexWork = "12345678-1234-4234-8234-123456789abc";
const artist = (provider: string) => ({
  providerId: provider,
  artistId: provider === "anilist" ? "126726" : mangaDexArtist,
  name: provider === "anilist" ? "Yuu Ichinomiya" : "Ichinomiya Yuu",
  aliases: [],
  url:
    provider === "anilist"
      ? "https://anilist.co/staff/126726"
      : `https://mangadex.org/author/${mangaDexArtist}`,
});
const work = (provider: string, page = 1) => ({
  providerId: provider,
  providerSeriesId: provider === "anilist" ? String(400 + page) : mangaDexWork,
  title:
    page === 1
      ? "An unexpected catalogue title"
      : "The work found on the second page",
  type: "MANGA",
  year: 2020,
  coverUrl: "/__test__/artist-cover.svg?number=1",
});
let applyRequests: unknown[];
let appliedCoverUrl: string | null;

test.beforeEach(async ({ page }) => {
  applyRequests = [];
  appliedCoverUrl = null;
  // Synthetic cover fixtures exercise image sizing without external providers.
  await page.route("**/__test__/artist-cover.svg?*", (route) => {
    const number =
      new URL(route.request().url()).searchParams.get("number") ?? "1";
    const color = ["#60475e", "#395d65", "#845943"][Number(number) % 3];
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><rect width="600" height="900" fill="${color}"/><g fill="#fff8fb" font-family="sans-serif"><text x="45" y="90" font-size="30">SAMPLE COVER</text><text x="45" y="520" font-size="200">${number}</text><text x="45" y="830" font-size="28">Artist works test fixture</text></g></svg>`,
    });
  });
  await page.route("**/__test__/missing-cover.jpg", (route) =>
    route.fulfill({ status: 404 })
  );
  await page.route("**/api/kavita/status", (route) =>
    route.fulfill({ json: { configured: true, version: "0.9.0" } })
  );
  await page.route("**/api/kavita/libraries", (route) =>
    route.fulfill({ json: [{ id: 7, name: "Sample library", seriesCount: 1 }] })
  );
  await page.route("**/api/kavita/libraries/7/series", (route) =>
    route.fulfill({
      json: [
        {
          id: 11,
          name: "A difficult local gallery name",
          libraryId: 7,
          status: "unmatched",
          artists: ["Yuu Ichinomiya"],
          tags: [],
        },
      ],
    })
  );
  await page.route("**/api/libraries/7/override", (route) =>
    route.fulfill({
      json: {
        libraryId: 7,
        priority: ["anilist", "mangadex"],
        autoMatch: false,
      },
    })
  );
  await page.route("**/api/recommendations", (route) =>
    route.fulfill({
      json: { items: [], ownedKeys: [], dismissedKeys: [], mode: "popular" },
    })
  );
  await page.route("**/api/series/11", (route) =>
    route.fulfill({
      json: {
        series: {
          id: 11,
          libraryId: 7,
          name: "A difficult local gallery name",
        },
        match: null,
        kavita: {
          summary: "Original metadata",
          pencillers: [{ id: 1, name: "Yuu Ichinomiya" }],
          writers: [],
          genres: [],
          tags: [],
        },
      },
    })
  );
  await page.route("**/api/series/11/identify", (route) =>
    route.fulfill({
      json: {
        candidates: [],
        best: null,
        searchedProviders: ["anilist", "mangadex"],
        errors: {},
        matched: false,
      },
    })
  );
  await page.route("**/api/series/11/applied-cover", (route) =>
    route.fulfill({
      json: {
        coverUrl: appliedCoverUrl,
        volumeCoverUrls: appliedCoverUrl ? [] : null,
      },
    })
  );
  await page.route("**/api/series/11/apply", async (route) => {
    applyRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: 99 } });
  });
  await page.route("**/api/providers/*/artists?*", (route) => {
    const url = new URL(route.request().url()),
      provider = url.pathname.split("/")[3];
    return route.fulfill({
      json: {
        items: [artist(provider)],
        page: Number(url.searchParams.get("page") ?? 1),
        hasNextPage: false,
      },
    });
  });
  await page.route("**/api/providers/*/artists/*/works?*", (route) => {
    const url = new URL(route.request().url()),
      provider = url.pathname.split("/")[3],
      number = Number(url.searchParams.get("page") ?? 1);
    const items =
      number === 1
        ? [
            work(provider),
            ...Array.from({ length: 7 }, (_, index) => ({
              ...work(provider),
              providerSeriesId: `600${index}`,
              title:
                index === 1
                  ? "A very long catalogue title that wraps across several lines while the complete name remains accessible"
                  : `Sample artist work ${index + 2}`,
              type: index === 2 ? "NOVEL" : "MANGA",
              year: 2015 + index,
              coverUrl:
                index === 5
                  ? undefined
                  : index === 6
                    ? "/__test__/missing-cover.jpg"
                    : `/__test__/artist-cover.svg?number=${index + 2}`,
            })),
          ]
        : [work(provider, number)];
    return route.fulfill({
      json: {
        items,
        page: number,
        hasNextPage: provider === "anilist" && number === 1,
      },
    });
  });
  await page.route("**/api/providers/*/series/*", (route) => {
    const url = new URL(route.request().url()),
      provider = url.pathname.split("/")[3];
    return route.fulfill({
      json: {
        ...work(provider, 2),
        providerSeriesId: url.pathname.split("/").pop(),
        summary: "Artist-discovered metadata for review",
        genres: [],
        tags: [],
        artists: ["Yuu Ichinomiya"],
        writers: [],
        titleOptions: ["The work found on the second page"],
      },
    });
  });
  await page.goto("/libraries?series=11&action=identify");
  await page.getByLabel("Username", { exact: true }).fill("upgrade-test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("upgrade-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", {
      name: "Identify “A difficult local gallery name”",
    })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Browse artist works", exact: true })
    .click();
});

test("artist browsing bypasses title matching, preserves provider pages, and reviews before applying", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Artist name or provider artist URL")
  ).toHaveValue("Yuu Ichinomiya");
  await expect(
    dialog.getByRole("button", { name: /An unexpected catalogue title/ })
  ).toBeVisible();
  const grid = dialog.getByRole("list", { name: "Artist works", exact: true });
  const backBounds = await dialog
    .getByRole("button", { name: "Back to matches", exact: true })
    .boundingBox();
  expect(backBounds!.height).toBeGreaterThanOrEqual(36);
  await expect(grid.getByRole("button")).toHaveCount(8);
  const [first, second] = await Promise.all([
    grid.getByRole("button").nth(0).boundingBox(),
    grid.getByRole("button").nth(1).boundingBox(),
  ]);
  expect(second!.y).toBe(first!.y);
  expect(second!.x).toBeGreaterThan(first!.x + first!.width);
  const cover = grid.getByRole("img", {
    name: "An unexpected catalogue title",
    exact: true,
  });
  await expect(cover).toBeVisible();
  expect(
    await cover.evaluate(
      (img: HTMLImageElement) => img.complete && img.naturalWidth > 0
    )
  ).toBe(true);
  const coverBounds = await cover.boundingBox();
  expect(coverBounds!.width).toBeGreaterThan(100);
  expect(coverBounds!.height / coverBounds!.width).toBeCloseTo(1.5);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  await grid.getByRole("button").first().focus();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  const chosenWork = dialog.getByRole("button", {
    name: /The work found on the second page/,
  });
  await expect(chosenWork).toBeVisible();
  await dialog.getByRole("tab", { name: "MangaDex", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Works by Ichinomiya Yuu" })
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "AniList", exact: true }).click();
  await expect(chosenWork).toBeVisible();
  await chosenWork.click();
  await expect(
    dialog.getByText("Artist-discovered metadata for review", { exact: true })
  ).toBeVisible();
  expect(applyRequests).toEqual([]);
  await dialog
    .getByRole("button", { name: "Back to artist works", exact: true })
    .click();
  await expect(chosenWork).toBeFocused();
  await chosenWork.click();
  await dialog.getByRole("button", { name: /^Apply/ }).click();
  await expect.poll(() => applyRequests.length).toBe(1);
  expect(applyRequests[0]).toMatchObject({
    providerId: "anilist",
    providerSeriesId: "402",
  });
});

test("example URLs select the right provider and artist works survive a recoverable provider error", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Artist name or provider artist URL");
  await input.fill(
    `https://mangadex.org/author/${mangaDexArtist}/ichinomiya-yuu`
  );
  await dialog
    .getByRole("button", { name: "Find artist", exact: true })
    .click();
  await expect(
    dialog.getByRole("tab", { name: "MangaDex", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("heading", { name: "Works by Ichinomiya Yuu" })
  ).toBeVisible();
  let failing = true;
  await page.route("**/api/providers/anilist/artists?*", (route) =>
    route.fulfill(
      failing
        ? { status: 502, json: { error: "Provider temporarily unavailable" } }
        : { json: { items: [artist("anilist")], page: 1, hasNextPage: false } }
    )
  );
  await input.fill("https://anilist.co/staff/126726/Yuu-Ichinomiya");
  await dialog
    .getByRole("button", { name: "Find artist", exact: true })
    .click();
  await expect(
    dialog.getByRole("tab", { name: "AniList", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByText("Provider temporarily unavailable", { exact: true })
  ).toBeVisible();
  failing = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Works by Yuu Ichinomiya" })
  ).toBeVisible();
});

test("MyAnimeList people links open cover tiles and use MAL metadata review", async ({
  page,
}, testInfo) => {
  const dialog = page.getByRole("dialog");
  await page.route("**/api/providers/myanimelist/artists?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            providerId: "myanimelist",
            artistId: "15043",
            name: "Myuuto Akatsuki",
            aliases: [],
            url: "https://myanimelist.net/people/15043",
          },
        ],
        page: 1,
        hasNextPage: false,
      },
    })
  );
  await dialog
    .getByLabel("Artist name or provider artist URL")
    .fill(
      "https://myanimelist.net/people/15043/Myuuto_Akatsuki?q=akatsuki%20myuuto&cat=person"
    );
  await dialog
    .getByRole("button", { name: "Find artist", exact: true })
    .click();
  await expect(
    dialog.getByRole("tab", { name: "MyAnimeList", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("heading", { name: "Works by Myuuto Akatsuki" })
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("list", { name: "Artist works", exact: true })
      .getByRole("button")
  ).toHaveCount(8);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  const output = path.resolve(".impeccable/review");
  fs.mkdirSync(output, { recursive: true });
  await dialog.screenshot({
    path: path.join(output, `mal-artist-works-${testInfo.project.name}.png`),
  });
  await dialog
    .getByRole("button", {
      name: "Review metadata for An unexpected catalogue title",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByText("Artist-discovered metadata for review", { exact: true })
  ).toBeVisible();
  expect(applyRequests).toEqual([]);
  await dialog.getByRole("button", { name: /^Apply/ }).click();
  await expect.poll(() => applyRequests.length).toBe(1);
  expect(applyRequests[0]).toMatchObject({ providerId: "myanimelist" });
});

test("artist choice, empty states, keyboard tabs and responsive themes stay usable", async ({
  page,
}, testInfo) => {
  const dialog = page.getByRole("dialog");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  await expect(
    dialog.getByRole("button", { name: /An unexpected catalogue title/ })
  ).toBeVisible();
  const output = path.resolve(".impeccable/review");
  fs.mkdirSync(output, { recursive: true });
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(document.images)
        .filter((img) => {
          const bounds = img.getBoundingClientRect();
          return bounds.top < innerHeight && bounds.bottom > 0;
        })
        .map((img) => img.decode().catch(() => {}))
    );
  });
  await dialog.screenshot({
    path: path.join(output, `artist-works-${testInfo.project.name}.png`),
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  );
  await dialog.screenshot({
    path: path.join(output, `artist-works-${testInfo.project.name}-dark.png`),
  });
  await dialog
    .getByRole("button", { name: "Change artist", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Yuu Ichinomiya", exact: true })
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "AniList", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    dialog.getByRole("tab", { name: "MangaDex", exact: true })
  ).toBeFocused();
  await page.route("**/api/providers/*/artists?*", (route) =>
    route.fulfill({ json: { items: [], page: 1, hasNextPage: false } })
  );
  await dialog
    .getByLabel("Artist name or provider artist URL")
    .fill("Unknown artist name");
  await dialog
    .getByRole("button", { name: "Find artist", exact: true })
    .click();
  await expect(dialog.getByText(/No artists found/)).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(viewport.width);
});

test("guided review leads with what will change and folds away what needs no decision", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: /An unexpected catalogue title/ })
    .first()
    .click();
  const heading = dialog.getByRole("heading", {
    name: /changes? ready to apply/,
  });
  await expect(heading).toBeVisible();
  // The primary action names exactly what it will do, and the count matches the summary.
  const apply = dialog.getByRole("button", { name: /^Apply \d+ changes?$/ });
  const count = Number((await apply.textContent())!.match(/\d+/)![0]);
  await expect(heading).toHaveText(
    count + " " + (count === 1 ? "change" : "changes") + " ready to apply"
  );
  // Only fields that change get a decision. Artists already match, so they are folded away rather than pre-checked.
  await expect(
    dialog.getByRole("group", { name: "Description", exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Artists", exact: true })
  ).toHaveCount(0);
  const unchanged = dialog
    .locator("summary")
    .filter({ hasText: /won.t change/ });
  await unchanged.click();
  await expect(
    dialog.locator("dd").filter({ hasText: "Already matches" })
  ).toBeVisible();
  // Skipping a field lowers the count and says so, without strikethrough.
  await dialog
    .getByRole("group", { name: "Description", exact: true })
    .getByRole("checkbox")
    .uncheck();
  await expect(
    dialog.getByRole("button", {
      name: new RegExp("^Apply " + (count - 1) + " change"),
    })
  ).toBeVisible();
  await expect(
    dialog.getByText("1 skipped by you", { exact: false })
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("group", { name: "Description", exact: true })
      .getByText("Not synced")
  ).toBeVisible();
  expect(applyRequests).toEqual([]);
  await dialog.getByRole("button", { name: /^Apply/ }).click();
  await expect.poll(() => applyRequests.length).toBe(1);
  expect(
    (applyRequests[0] as { excludedFields: string[] }).excludedFields
  ).toContain("summary");
});

test("a cover H-Tosho already applied is not proposed as a change", async ({
  page,
}) => {
  appliedCoverUrl = work("anilist").coverUrl;
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: /An unexpected catalogue title/ })
    .first()
    .click();
  await expect(
    dialog.getByText("H-Tosho already applied this cover.")
  ).toBeVisible();
  await expect(dialog.getByText("Proposed · already applied")).toBeVisible();
  const again = dialog.getByRole("checkbox", { name: "Apply it again" });
  await expect(again).not.toBeChecked();
  const apply = dialog.getByRole("button", { name: /^Apply \d+ changes?$/ });
  const count = Number((await apply.textContent())!.match(/\d+/)![0]);
  // Opting back in counts the cover again.
  await again.check();
  await expect(
    dialog.getByRole("button", {
      name: new RegExp("^Apply " + (count + 1) + " change"),
    })
  ).toBeVisible();
  await again.uncheck();
  await apply.click();
  await expect.poll(() => applyRequests.length).toBe(1);
  expect((applyRequests[0] as { cover: boolean }).cover).toBe(false);
});
