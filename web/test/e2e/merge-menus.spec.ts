import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const gallery = {
  source: "hitomi",
  galleryId: "menu-sample",
  title: "Garden Stories 02",
  artists: ["Sample Artist"],
  tags: [],
  pageCount: 24,
};

async function capture(page: Page, testInfo: TestInfo, menu: string) {
  const directory = path.resolve(".impeccable/review");
  fs.mkdirSync(directory, { recursive: true });
  await page.locator("main").evaluate((element) => {
    element.scrollTop = 0;
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle("dark", value === "dark"),
      theme
    );
    await page.screenshot({
      path: path.join(
        directory,
        `${menu}-${testInfo.project.name}-${theme}.png`
      ),
      fullPage: true,
      animations: "disabled",
    });
  }
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/kavita/status", (route) =>
    route.fulfill({ json: { configured: true, hasApiKey: true } })
  );
  await page.route("**/api/kavita/libraries", (route) =>
    route.fulfill({ json: [{ id: 7, name: "Collection", seriesCount: 2 }] })
  );
  await page.route("**/api/kavita/libraries/7/series", (route) =>
    route.fulfill({
      json: [
        {
          id: 50,
          name: "Garden Stories 01",
          status: "unmatched",
          artists: ["Sample Artist"],
          bookCount: 1,
        },
        {
          id: 51,
          name: "Seasonal Stories",
          status: "unmatched",
          artists: ["Sample Artist"],
          bookCount: 1,
        },
      ],
    })
  );
  await page.route("**/api/settings/downloader", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        downloadDirectory: "/library/downloads",
        format: "cbz",
      },
    });
  });
  await page.route("**/api/cbz/roots", (route) =>
    route.fulfill({ json: { roots: ["/library/downloads"] } })
  );
  await page.route("**/api/cbz/series/*", (route) => {
    const id = Number(route.request().url().split("/").pop());
    const file = `/library/${id}/Chapter ${id === 50 ? "01" : "02"}.cbz`;
    return route.fulfill({
      json: {
        seriesId: id,
        dir: `/library/${id}`,
        reason: null,
        files: [file],
        chapterNumbers: { [file]: id === 50 ? "1" : "2" },
      },
    });
  });
  await page.route("**/api/doujin/search", (route) =>
    route.fulfill({ json: { items: [gallery], total: 1 } })
  );
  await page.route("**/api/downloads/library-matches", (route) =>
    route.fulfill({ json: { items: [], incomplete: false, errors: [] } })
  );
  await page.route("**/api/downloads/gallery-files?**", (route) =>
    route.fulfill({ json: { files: [] } })
  );
  await page.route("**/api/downloads/duplicates", (route) =>
    route.fulfill({ json: { reports: [], warnings: [] } })
  );
  await page.route("**/api/merge-protection/preview", (route) =>
    route.fulfill({
      json: {
        series: [],
        inheritedFields: [],
        unassociatedArchives: 0,
        canQueue: true,
        warnings: [],
      },
    })
  );
  await page.route("**/api/recommendations", (route) =>
    route.fulfill({
      json: {
        date: "2026-10-29",
        generatedAt: "2026-10-29T10:00:00Z",
        mode: "popular",
        profile: { artists: [], tags: [], series: [], language: null },
        items: [{ ...gallery, reasons: [] }],
        ownedKeys: [],
        dismissedKeys: [],
        repeatedCount: 0,
        degradedReason: null,
      },
    })
  );
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("upgrade-test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("upgrade-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Home", exact: true })
  ).toBeVisible();
});

test("library merges apply the chosen name independently of a custom folder", async ({
  page,
}, testInfo) => {
  await page.goto("/libraries/7");
  await page
    .getByRole("button", { name: "Select to merge", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Garden Stories 01", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Seasonal Stories", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Series selection", exact: true })
    .getByRole("button", { name: /^Merge/ })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Merge series",
    exact: true,
  });
  const name = dialog.getByLabel("Merged series name", { exact: true });
  const queue = dialog.getByRole("button", {
    name: "Queue merge",
    exact: true,
  });
  await expect(name).toHaveValue("Garden Stories 01");
  await name.fill(" ");
  await expect(queue).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveText("Enter a series name.");
  await name.fill("Garden: Collected / Stories");
  await expect(
    dialog.getByLabel("Target folder", { exact: true })
  ).toHaveAttribute(
    "placeholder",
    "/library/downloads/Garden Collected Stories"
  );
  await dialog
    .getByLabel("Target folder", { exact: true })
    .fill("/library/Custom folder");
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await expect(queue).toBeEnabled();
  await capture(page, testInfo, "library-merge-name");
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let submission: Record<string, unknown> | undefined;
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submission = route.request().postDataJSON();
    await pending;
    return route.fulfill({ json: { id: 9100 } });
  });
  try {
    await queue.click();
    await expect(name).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true })
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    finish();
  }
  await expect(dialog).toHaveCount(0);
  expect(submission).toMatchObject({
    type: "merge-series",
    seriesName: "Garden: Collected / Stories",
    targetDir: "/library/Custom folder",
    sourceFiles: ["/library/50/Chapter 01.cbz", "/library/51/Chapter 02.cbz"],
  });
});

for (const tab of ["search", "recommend"]) {
  async function selectGallery(page: Page) {
    await page.goto(
      tab === "search"
        ? "/downloader?tab=search&q=garden"
        : "/downloader?tab=recommend"
    );
    await page
      .getByRole("button", { name: "Select galleries", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select Garden Stories 02", exact: true })
      .click();
  }

  test(`${tab} supports optional rename when adding to an existing series`, async ({
    page,
  }, testInfo) => {
    await selectGallery(page);
    if (tab === "recommend")
      await capture(page, testInfo, "recommended-merge-selection");
    await page
      .getByRole("button", { name: "Add to existing series", exact: true })
      .filter({ visible: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Merge into series",
      exact: true,
    });
    await dialog
      .getByRole("button", {
        name: "Select Garden Stories 01 as merge target",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("switch", { name: "Rename series", exact: true })
      .click();
    await dialog
      .getByLabel("New series name", { exact: true })
      .fill("Garden Collection");
    let submission: Record<string, unknown> | undefined;
    await page.route("**/api/jobs", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submission = route.request().postDataJSON();
      return route.fulfill({ json: { id: 9101 } });
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
    expect(submission).toMatchObject({
      type: "merge-series",
      seriesId: 50,
      seriesName: "Garden Collection",
      downloads: [{ galleryId: gallery.galleryId, chapter: "2" }],
    });
  });

  test(`${tab} can choose the name for a newly merged download`, async ({
    page,
  }, testInfo) => {
    await selectGallery(page);
    await page
      .getByRole("button", { name: "Merge into new series", exact: true })
      .filter({ visible: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Merged download",
      exact: true,
    });
    const name = dialog.getByLabel("Merged series name", { exact: true });
    await expect(name).toHaveValue(gallery.title);
    await name.fill("Garden Collection");
    if (tab === "search") await capture(page, testInfo, "new-merge-name");
    let submission: Record<string, unknown> | undefined;
    await page.route("**/api/downloads/merged", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submission = route.request().postDataJSON();
      return route.fulfill({
        json: {
          items: [
            {
              source: gallery.source,
              galleryId: gallery.galleryId,
              id: 9102,
              status: "queued",
            },
          ],
        },
      });
    });
    await dialog
      .getByRole("checkbox", {
        name: "I reviewed current protection and lock inheritance.",
      })
      .check();
    await dialog
      .getByRole("button", { name: "Download 1 gallery", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(submission).toMatchObject({
      mergeFolder: "Garden Collection",
      items: [{ galleryId: gallery.galleryId, chapter: 1 }],
    });
  });
}

test("three selected galleries are submitted as one merged batch with their chapter order", async ({
  page,
}) => {
  const galleries = [1, 2, 3].map((chapter) => ({
    ...gallery,
    galleryId: `batch-${chapter}`,
    title: `Garden Chapter ${chapter}`,
  }));
  await page.route("**/api/doujin/search", (route) =>
    route.fulfill({ json: { items: galleries, total: galleries.length } })
  );
  await page.goto("/downloader?tab=search&q=garden");
  await page
    .getByRole("button", { name: "Select galleries", exact: true })
    .click();
  for (const item of galleries)
    await page
      .getByRole("button", { name: `Select ${item.title}`, exact: true })
      .click();
  await page
    .getByRole("button", { name: "Merge into new series", exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Merged download",
    exact: true,
  });
  await dialog
    .getByLabel("Merged series name", { exact: true })
    .fill("Garden Collection");
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/downloads/merged", (route) => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        items: galleries.map((item, i) => ({
          source: item.source,
          galleryId: item.galleryId,
          id: 9200 + i,
        })),
      },
    });
  });
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await dialog
    .getByRole("button", { name: "Download 3 galleries", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toEqual([
    {
      mergeFolder: "Garden Collection",
      items: galleries.map((item, i) => ({
        source: item.source,
        galleryId: item.galleryId,
        chapter: i + 1,
        allowDuplicate: false,
      })),
    },
  ]);
});

test("gallery details show searchable groups and circles", async ({
  page,
}, testInfo) => {
  const queries: string[] = [];
  await page.route("**/api/doujin/search", (route) => {
    queries.push(route.request().postDataJSON().query);
    return route.fulfill({ json: { items: [gallery], total: 1 } });
  });
  await page.route("**/api/doujin/gallery", (route) =>
    route.fulfill({
      json: { ...gallery, groups: ["shirukke no ooi zakuro"], pages: [] },
    })
  );
  await page.goto("/downloader?tab=search&q=garden");
  await page
    .getByRole("button", {
      name: `View details for ${gallery.title}`,
      exact: true,
    })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Groups / circles", { exact: true })
  ).toBeVisible();
  const circle = dialog.getByRole("button", {
    name: "shirukke no ooi zakuro",
    exact: true,
  });
  await expect(circle).toBeVisible();
  await expect(circle).toHaveAttribute(
    "title",
    "Search Hitomi.la for “group:shirukke_no_ooi_zakuro”"
  );
  const directory = path.resolve(".impeccable/review");
  fs.mkdirSync(directory, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle("dark", value === "dark"),
      theme
    );
    await dialog.screenshot({
      path: path.join(
        directory,
        `gallery-circles-${testInfo.project.name}-${theme}.png`
      ),
      animations: "disabled",
    });
  }
  await circle.click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => queries).toContain("group:shirukke_no_ooi_zakuro");
});

test("a merged batch retry keeps successful entries and the remaining chapter number", async ({
  page,
}) => {
  const galleries = [1, 2, 3].map((chapter) => ({
    ...gallery,
    galleryId: `retry-${chapter}`,
    title: `Retry Chapter ${chapter}`,
  }));
  await page.route("**/api/doujin/search", (route) =>
    route.fulfill({ json: { items: galleries, total: galleries.length } })
  );
  await page.goto("/downloader?tab=search&q=garden");
  await page
    .getByRole("button", { name: "Select galleries", exact: true })
    .click();
  for (const item of galleries)
    await page
      .getByRole("button", { name: `Select ${item.title}`, exact: true })
      .click();
  await page
    .getByRole("button", { name: "Merge into new series", exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Merged download",
    exact: true,
  });
  const submissions: { items: { galleryId: string; chapter: number }[] }[] = [];
  await page.route("**/api/downloads/merged", (route) => {
    submissions.push(route.request().postDataJSON());
    const items =
      submissions.length === 1
        ? [
            { ...galleries[0], id: 9301 },
            { ...galleries[1], error: "already-downloaded" },
            { ...galleries[2], error: "Provider unavailable" },
          ]
        : [{ ...galleries[2], id: 9303 }];
    return route.fulfill({ json: { items } });
  });
  await dialog
    .getByRole("checkbox", {
      name: "I reviewed current protection and lock inheritance.",
    })
    .check();
  await dialog
    .getByRole("button", { name: "Download 3 galleries", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "1 queued · 1 already owned or queued · 1 needs retry"
  );
  await dialog
    .getByRole("button", { name: "Retry remaining (1)", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1].items).toEqual([
    {
      source: "hitomi",
      galleryId: "retry-3",
      chapter: 3,
      allowDuplicate: false,
    },
  ]);
});
