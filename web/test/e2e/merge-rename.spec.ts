import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/settings/downloader", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        downloadDirectory: "/library/downloads",
      },
    });
  });
  await page.route("**/api/downloads/gallery-files?**", (route) =>
    route.fulfill({ json: { files: [] } })
  );
  await page.route("**/api/downloads/library-matches", (route) =>
    route.fulfill({ json: { reports: [], warnings: [] } })
  );
  await page.route("**/api/downloads/duplicates", (route) =>
    route.fulfill({ json: { reports: [], warnings: [] } })
  );
  await page.route("**/api/kavita/libraries", (route) =>
    route.fulfill({ json: [{ id: 7, name: "Collection" }] })
  );
  await page.route("**/api/kavita/libraries/7/series", (route) =>
    route.fulfill({
      json: [
        {
          id: 50,
          name: "Garden Stories 01",
          artists: ["Sample Artist"],
          status: "unmatched",
        },
        {
          id: 51,
          name: "Seasonal Stories",
          artists: ["Sample Artist"],
          status: "unmatched",
        },
      ],
    })
  );
  await page.route("**/api/cbz/series/*", (route) => {
    const id = Number(route.request().url().split("/").pop());
    return route.fulfill({
      json: {
        seriesId: id,
        dir: `/library/${id}`,
        reason: null,
        files: [`/library/${id}/Chapter 01.cbz`],
        chapterNumbers: { [`/library/${id}/Chapter 01.cbz`]: "1" },
      },
    });
  });
  await page.route("**/api/watched-searches/feed?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            source: "hitomi",
            galleryId: "sample-02",
            title: "Garden Stories 02",
            artists: ["Sample Artist"],
            searchId: 1,
            query: "artist:sample",
            watchLabel: "Sample Artist",
            watchRemoved: false,
            foundAt: "2026-10-29T10:00:00Z",
            reviewedAt: null,
          },
        ],
        total: 1,
        inboxCount: 1,
        historyCount: 0,
        watches: [],
      },
    })
  );
  await page.route("**/api/merge-protection/preview", (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        series: [
          {
            seriesId: body.seriesId,
            libraryId: 7,
            name:
              body.seriesId === 51 ? "Seasonal Stories" : "Garden Stories 01",
            role: "target",
            lockedFields: [],
            revision: 0,
            titleChange: !!body.seriesName,
          },
        ],
        inheritedFields: [],
        unassociatedArchives: 0,
        canQueue: true,
        warnings: [],
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("upgrade-test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("upgrade-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Home", exact: true })
  ).toBeVisible();
  await page.goto("/downloader?tab=watched");
  await page
    .getByRole("button", { name: "Select galleries", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Garden Stories 02", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add to existing series", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("button", {
      name: "Select Garden Stories 01 as merge target",
      exact: true,
    })
    .click();
});

test("Watched can rename with a queued merge and preserve drafts after an error", async ({
  page,
}, testInfo) => {
  const dialog = page.getByRole("dialog", { name: "Merge into series" });
  const queue = dialog.getByRole("button", {
    name: "Queue merge (1 gallery)",
    exact: true,
  });
  await expect(queue).toBeDisabled();
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await expect(queue).toBeEnabled();
  await expect(
    dialog.getByLabel("New series name", { exact: true })
  ).toHaveCount(0);
  await dialog
    .getByRole("switch", { name: "Rename series", exact: true })
    .click();
  const name = dialog.getByLabel("New series name", { exact: true });
  await expect(name).toHaveValue("Garden Stories 01");
  await name.fill(" ");
  await expect(queue).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Enter a series name, or turn off Rename series."
  );
  await name.fill("Garden Stories — Collected Chapters");
  await dialog
    .getByRole("textbox", {
      name: "Chapter number for Chapter 01.cbz",
      exact: true,
    })
    .fill("1.5");
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await expect(queue).toBeEnabled();
  await expect(
    dialog.getByText("Rename on merge:", { exact: false })
  ).toContainText("Garden Stories — Collected Chapters");
  const captures = path.resolve(".impeccable/review");
  fs.mkdirSync(captures, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle("dark", value === "dark"),
      theme
    );
    await name.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(captures, `merge-${testInfo.project.name}-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await dialog
      .locator("div.overflow-y-auto")
      .first()
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await page.screenshot({
      path: path.join(
        captures,
        `merge-${testInfo.project.name}-${theme}-top.png`
      ),
      fullPage: true,
      animations: "disabled",
    });
  }
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions.push(route.request().postDataJSON());
    return route.fulfill(
      submissions.length === 1
        ? { status: 500, json: { error: "Try again" } }
        : { json: { id: 9001 } }
    );
  });
  await queue.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Could not queue the merge. Drafts kept; try again."
  );
  await expect(name).toHaveValue("Garden Stories — Collected Chapters");
  await queue.click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toMatchObject({
    type: "merge-series",
    seriesId: 50,
    seriesName: "Garden Stories — Collected Chapters",
    existingChapters: { "/library/50/Chapter 01.cbz": "1.5" },
    downloads: [{ galleryId: "sample-02", chapter: "2" }],
  });
});

test("changing targets resets rename drafts and leaving rename off keeps the existing name", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog", { name: "Merge into series" });
  await dialog
    .getByRole("switch", { name: "Rename series", exact: true })
    .click();
  await dialog
    .getByLabel("New series name", { exact: true })
    .fill("Temporary draft");
  await dialog
    .getByRole("button", {
      name: "Select Seasonal Stories as merge target",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("switch", { name: "Rename series", exact: true })
  ).not.toBeChecked();
  await dialog
    .getByRole("switch", { name: "Rename series", exact: true })
    .click();
  await expect(
    dialog.getByLabel("New series name", { exact: true })
  ).toHaveValue("Seasonal Stories");
  await dialog
    .getByLabel("New series name", { exact: true })
    .fill("Ignored draft");
  await dialog
    .getByRole("switch", { name: "Rename series", exact: true })
    .click();
  let submission: Record<string, unknown> | undefined;
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submission = route.request().postDataJSON();
    return route.fulfill({ json: { id: 9002 } });
  });
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await dialog
    .getByRole("button", { name: "Queue merge (1 gallery)", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(submission?.seriesId).toBe(51);
  expect(submission).not.toHaveProperty("seriesName");
});

test("renaming requires a real revision-safe unlock and refreshed protection approval", async ({
  page,
}) => {
  let fields = ["title", "cover"];
  let revision = 4;
  const policyWrites: unknown[] = [];
  await page.route("**/api/series/50/field-locks", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      policyWrites.push(body);
      if (body.expectedRevision !== revision)
        return route.fulfill({
          status: 409,
          json: { error: "Protection settings changed" },
        });
      fields = body.lockedFields;
      revision++;
    }
    return route.fulfill({ json: { lockedFields: fields, revision } });
  });
  await page.route("**/api/merge-protection/preview", (route) => {
    const body = route.request().postDataJSON();
    const changing = body.seriesName && body.seriesName !== "Garden Stories 01";
    return route.fulfill({
      json: {
        series: [
          {
            seriesId: 50,
            libraryId: 7,
            name: "Garden Stories 01",
            role: "target",
            lockedFields: fields,
            revision,
            titleChange: !!changing,
          },
        ],
        inheritedFields: fields,
        unassociatedArchives: 0,
        canQueue: !changing || !fields.includes("title"),
        warnings: [],
      },
    });
  });
  const dialog = page.getByRole("dialog", { name: "Merge into series" });
  await dialog
    .getByRole("switch", { name: "Rename series", exact: true })
    .click();
  await dialog
    .getByLabel("New series name", { exact: true })
    .fill("Protected rename");
  const queue = dialog.getByRole("button", {
    name: "Queue merge (1 gallery)",
    exact: true,
  });
  await expect(queue).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
  ).toBeDisabled();
  await dialog
    .getByRole("button", {
      name: "Unlock title for Garden Stories 01",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
  ).toBeEnabled();
  await expect(queue).toBeDisabled();
  expect(policyWrites).toEqual([
    { lockedFields: ["cover"], expectedRevision: 4 },
  ]);
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await expect(queue).toBeEnabled();
  await dialog
    .getByLabel("New series name", { exact: true })
    .fill("Another draft");
  await expect(queue).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
  ).not.toBeChecked();
});

test("ComicInfo authoring explains protection, keeps manual editing enabled, and does not silently unlock", async ({
  page,
}, testInfo) => {
  const xml =
    "<ComicInfo><Series>Protected title</Series><Summary>Protected summary</Summary></ComicInfo>";
  await page.route("**/api/kavita/status", (route) =>
    route.fulfill({ json: { configured: true, version: "0.9.1" } })
  );
  await page.route("**/api/series/50", (route) =>
    route.fulfill({
      json: {
        series: {
          id: 50,
          libraryId: 7,
          name: "Garden Stories 01",
          cover: null,
          status: "unmatched",
        },
        match: null,
        history: [],
      },
    })
  );
  await page.route("**/api/cbz/comicinfo?**", (route) =>
    route.fulfill({
      json: {
        path: "/library/50/Chapter 01.cbz",
        hasEntry: true,
        fields: { Series: "Protected title", Summary: "Protected summary" },
        order: ["Series", "Summary"],
        raw: xml,
      },
    })
  );
  let unlocks = 0;
  await page.route("**/api/series/50/field-locks", (route) => {
    if (route.request().method() === "PUT") unlocks++;
    return route.fulfill({
      json: { lockedFields: ["title", "summary"], revision: 2 },
    });
  });
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 9900 } });
  });
  await page.goto("/libraries/7?series=50&action=comicinfo");
  const editor = page.getByRole("dialog", {
    name: "Edit ComicInfo",
    exact: true,
  });
  await editor
    .getByRole("button", {
      name: "Open /library/50/Chapter 01.cbz",
      exact: true,
    })
    .click();
  await expect(
    editor.getByRole("region", { name: "ComicInfo protection scope" })
  ).toContainText("title, summary");
  await expect(
    editor.getByText(
      "Deliberate manual ComicInfo editing is allowed and does not clear protection.",
      { exact: false }
    )
  ).toBeVisible();
  await editor.getByLabel("Series", { exact: true }).fill("Deliberate edit");
  await page.screenshot({
    path: `.impeccable/review/comicinfo-protection-${testInfo.project.name}-light.png`,
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: `.impeccable/review/comicinfo-protection-${testInfo.project.name}-dark.png`,
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await editor.getByRole("button", { name: "Queue save", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    type: "edit-comicinfo",
    seriesId: 50,
    fields: { Series: "Deliberate edit" },
  });
  expect(unlocks).toBe(0);
  await page.goto("/libraries?file=%2Flibrary%2F50%2FChapter%2001.cbz");
  const pathEditor = page.getByRole("dialog", {
    name: "Edit ComicInfo",
    exact: true,
  });
  await expect(
    pathEditor.getByRole("region", { name: "ComicInfo protection scope" })
  ).toContainText("Series protection is unavailable for this path");
  await pathEditor.getByLabel("Series", { exact: true }).fill("Path-only edit");
  await pathEditor
    .getByRole("button", { name: "Queue save", exact: true })
    .click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).not.toHaveProperty("seriesId");
  expect(unlocks).toBe(0);
});
