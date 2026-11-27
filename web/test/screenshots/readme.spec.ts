import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// README screenshots: the real interface with fictional series, artists and
// generated cover art, so no third-party artwork or personal data is shown.
const outDir = fileURLToPath(
  new URL("../../../docs/screenshots/", import.meta.url)
);

interface SampleSeries {
  id: number;
  slug: string;
  name: string;
  artist: string;
  status: "matched" | "unmatched";
  /** Match confidence; below 0.8 the UI files a match under Needs review. */
  score?: number;
  pages: number;
  added: string;
  palette: [string, string, string];
  motif: (accent: string) => string;
}

const lanterns = (accent: string) =>
  [90, 210, 330, 450, 540]
    .map(
      (x, i) =>
        `<circle cx="${x}" cy="${250 + (i % 2) * 70}" r="${38 - (i % 3) * 6}" fill="${accent}" opacity="0.9"/>`
    )
    .join("") +
  `<path d="M0 620 L80 560 L80 520 L150 520 L150 580 L230 540 L230 480 L300 480 L300 560 L390 510 L390 460 L470 460 L470 540 L600 500 L600 900 L0 900 Z" fill="#0b1020" opacity="0.85"/>`;
const stars = (accent: string) =>
  `<circle cx="420" cy="230" r="120" fill="${accent}"/><circle cx="470" cy="190" r="110" fill="#f5d6b8"/>` +
  [
    [140, 230],
    [200, 300],
    [80, 420],
    [300, 120],
    [250, 470],
    [170, 520],
  ]
    .map(
      ([x, y]) =>
        `<path d="M${x} ${y - 18} L${x + 5} ${y - 5} L${x + 18} ${y} L${x + 5} ${y + 5} L${x} ${y + 18} L${x - 5} ${y + 5} L${x - 18} ${y} L${x - 5} ${y - 5} Z" fill="#fffaf0"/>`
    )
    .join("");
const waves = (accent: string) =>
  [360, 440, 520, 600]
    .map(
      (y, i) =>
        `<path d="M0 ${y} C100 ${y - 60} 200 ${y + 60} 300 ${y} S500 ${y - 60} 600 ${y} L600 900 L0 900 Z" fill="${accent}" opacity="${0.35 + i * 0.15}"/>`
    )
    .join("") +
  `<circle cx="300" cy="230" r="70" fill="none" stroke="#e8fbff" stroke-width="10"/>`;
const garden = (accent: string) =>
  `<circle cx="300" cy="330" r="170" fill="none" stroke="${accent}" stroke-width="26" stroke-dasharray="40 22"/>` +
  `<path d="M300 620 C300 520 300 420 300 330" stroke="#d9f2c9" stroke-width="12" fill="none"/>` +
  `<path d="M300 470 C230 450 200 400 210 350 C270 360 300 410 300 470 Z" fill="#9fd08a"/>` +
  `<path d="M300 420 C370 400 400 350 390 300 C330 310 300 360 300 420 Z" fill="#9fd08a"/>`;
const moon = (accent: string) =>
  `<circle cx="380" cy="230" r="110" fill="${accent}"/>` +
  `<path d="M-20 700 Q300 430 640 560" stroke="#f3e9ff" stroke-width="14" fill="none" opacity="0.7"/>` +
  [
    [150, 200],
    [200, 240],
    [120, 280],
  ]
    .map(
      ([x, y]) =>
        `<path d="M${x - 20} ${y} Q${x - 10} ${y - 12} ${x} ${y} Q${x + 10} ${y - 12} ${x + 20} ${y}" stroke="#f3e9ff" stroke-width="5" fill="none"/>`
    )
    .join("");

const SERIES: SampleSeries[] = [
  {
    id: 101,
    slug: "paper-lantern-detective",
    name: "Paper Lantern Detective",
    artist: "Haruki Amanome",
    status: "matched",
    pages: 2200,
    added: "2026-11-20T00:00:00Z",
    palette: ["#1d2547", "#3b2f63", "#ffb347"],
    motif: lanterns,
  },
  {
    id: 102,
    slug: "starfall-bakery",
    name: "Starfall Bakery",
    artist: "Nanami Kurose",
    status: "unmatched",
    pages: 1600,
    added: "2026-11-19T00:00:00Z",
    palette: ["#e98a6b", "#f2b880", "#fbe3a1"],
    motif: stars,
  },
  {
    id: 103,
    slug: "the-ninth-tide",
    name: "The Ninth Tide",
    artist: "Ren Takamori",
    status: "matched",
    score: 0.76,
    pages: 4600,
    added: "2026-11-18T00:00:00Z",
    palette: ["#0f4c5c", "#1b7a8c", "#7fd3e0"],
    motif: waves,
  },
  {
    id: 104,
    slug: "iron-garden",
    name: "Iron Garden",
    artist: "Kaito Morisaki",
    status: "matched",
    pages: 2000,
    added: "2026-11-17T00:00:00Z",
    palette: ["#22352a", "#3e5a45", "#c4a35a"],
    motif: garden,
  },
  {
    id: 105,
    slug: "moonlit-courier",
    name: "Moonlit Courier",
    artist: "Aoi Fujisawa",
    status: "unmatched",
    pages: 2400,
    added: "2026-11-16T00:00:00Z",
    palette: ["#2a1b47", "#5b3a87", "#ffe8a3"],
    motif: moon,
  },
];
const PREVIEW = SERIES[4];

function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** A generated, clearly fictional volume cover for a sample series. */
function cover(series: SampleSeries) {
  const [top, bottom, accent] = series.palette;
  const words = series.name.toUpperCase().split(" ");
  const lines =
    words.length > 2 ? [words.slice(0, -1).join(" "), words.at(-1)!] : words;
  // Library cards crop about 100px from the top and bottom; keep text inside.
  const title = lines
    .map(
      (line, i) =>
        `<text x="44" y="${625 + i * 60}" font-size="${line.length > 12 ? 46 : 54}">${escapeXml(line)}</text>`
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  ${series.motif(accent)}
  <rect x="0" y="560" width="600" height="340" fill="#000" opacity="0.28"/>
  <g fill="#fffaf5" font-family="Georgia, 'Times New Roman', serif" font-weight="700">${title}</g>
  <text x="44" y="${625 + lines.length * 60 + 20}" fill="#fffaf5" opacity="0.85" font-family="Arial, sans-serif" font-size="22" letter-spacing="3">${escapeXml(series.artist.toUpperCase())}</text>
  <text x="44" y="150" fill="#fffaf5" opacity="0.9" font-family="Arial, sans-serif" font-weight="700" font-size="24" letter-spacing="4">VOL. 1</text>
</svg>`;
}

const coverUrl = (series: SampleSeries) =>
  `/__screenshots__/cover/${series.slug}.svg`;

const rows = SERIES.map((series) => ({
  id: series.id,
  libraryId: 7,
  libraryName: "Manga",
  name: series.name,
  pageCount: series.pages,
  cover: coverUrl(series),
  status: series.status,
  providerId: series.status === "unmatched" ? null : "anilist",
  matchScore: series.score ?? (series.status === "matched" ? 0.97 : null),
  confirmed: false,
  dateAdded: series.added,
  artists: series.status === "unmatched" ? [] : [series.artist],
  tags: [],
}));

async function sampleLibrary(page: Page) {
  await page.route("**/__screenshots__/cover/*.svg", (route) => {
    const slug = new URL(route.request().url()).pathname
      .split("/")
      .pop()!
      .replace(/\.svg$/, "");
    const series = SERIES.find((s) => s.slug === slug);
    return series
      ? route.fulfill({ contentType: "image/svg+xml", body: cover(series) })
      : route.fulfill({ status: 404 });
  });
  // Show a neutral account name instead of the isolated test account.
  for (const endpoint of ["**/api/auth/status", "**/api/auth/login"])
    await page.route(endpoint, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { username?: string | null };
      await route.fulfill({
        response,
        json: body.username ? { ...body, username: "Reader" } : body,
      });
    });
  await page.route("**/api/recommendations", (route) =>
    route.fulfill({
      json: { items: [], ownedKeys: [], dismissedKeys: [], mode: "popular" },
    })
  );
  await page.route("**/api/kavita/status", (route) =>
    route.fulfill({ json: { configured: true, version: "0.9.1" } })
  );
  await page.route("**/api/kavita/libraries", (route) =>
    route.fulfill({
      json: [
        { id: 7, name: "Manga", seriesCount: rows.length, matchedCount: 2 },
      ],
    })
  );
  await page.route("**/api/kavita/libraries/7/series", (route) =>
    route.fulfill({ json: rows })
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
  await page.route("**/api/series/low-confidence", (route) =>
    route.fulfill({ json: { count: 1, threshold: 0.8 } })
  );
  await page.route("**/api/series/needs-review", (route) =>
    route.fulfill({ json: rows.filter((row) => (row.matchScore ?? 1) < 0.8) })
  );
  const candidate = {
    providerId: "anilist",
    providerSeriesId: "sample-moonlit-courier",
    title: "Moonlit Courier",
    type: "MANGA",
    year: 2021,
    coverUrl: coverUrl(PREVIEW),
    summary:
      "A night-shift courier delivers letters that can only be read by moonlight, and learns that one of them is addressed to her.",
    score: 0.98,
  };
  await page.route(`**/api/series/${PREVIEW.id}`, (route) =>
    route.fulfill({
      json: {
        series: {
          id: PREVIEW.id,
          libraryId: 7,
          name: PREVIEW.name,
          cover: coverUrl(PREVIEW),
        },
        match: null,
        metadata: null,
        kavita: {
          summary: null,
          genres: [],
          tags: [{ id: 1, title: "Manga" }],
          writers: [],
          pencillers: [],
          releaseYear: 0,
        },
      },
    })
  );
  await page.route(`**/api/series/${PREVIEW.id}/identify`, (route) =>
    route.fulfill({
      json: {
        matched: true,
        best: candidate,
        candidates: [candidate],
        searchedProviders: ["anilist"],
        errors: {},
      },
    })
  );
  await page.route(`**/api/series/${PREVIEW.id}/applied-cover`, (route) =>
    route.fulfill({ json: { coverUrl: null, volumeCoverUrls: null } })
  );
  await page.route(
    `**/api/providers/anilist/series/${candidate.providerSeriesId}`,
    (route) =>
      route.fulfill({
        json: {
          providerId: "anilist",
          providerSeriesId: candidate.providerSeriesId,
          title: "Moonlit Courier",
          titleOptions: ["Moonlit Courier", "Tsukiyo no Haitatsunin"],
          year: 2021,
          summary: candidate.summary,
          coverUrl: candidate.coverUrl,
          genres: ["Drama", "Fantasy", "Slice of Life"],
          tags: ["Manga", "Night Shift", "Letters", "Found Family"],
          writers: [PREVIEW.artist],
          artists: [PREVIEW.artist],
        },
      })
  );
}

async function signIn(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel("Username", { exact: true }).fill("upgrade-test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("upgrade-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function waitForCovers(page: Page, count: number) {
  const covers = page.locator('img[src^="/__screenshots__/cover/"]');
  await expect(covers.first()).toBeVisible();
  await expect
    .poll(() =>
      covers.evaluateAll(
        (images) =>
          (images as HTMLImageElement[]).filter(
            (image) => image.complete && image.naturalWidth > 0
          ).length
      )
    )
    .toBeGreaterThanOrEqual(count);
  // Let entrance motion settle before capturing.
  await page.waitForTimeout(800);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 800 } });

  test("libraries.png", async ({ page }) => {
    await sampleLibrary(page);
    await signIn(page, "/libraries/7");
    await expect(page.getByText(PREVIEW.name, { exact: true })).toBeVisible();
    await waitForCovers(page, SERIES.length);
    await page.screenshot({ path: `${outDir}libraries.png` });
  });

  test("metadata-preview.png", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1320 });
    await sampleLibrary(page);
    await signIn(page, `/libraries/7?series=${PREVIEW.id}&action=identify`);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: `Identify “${PREVIEW.name}”` })
    ).toBeVisible();
    const review = dialog.getByText("changes ready to apply");
    if (!(await review.isVisible().catch(() => false)))
      await dialog.locator("[data-candidate-key]").first().click();
    await expect(review).toBeVisible();
    await waitForCovers(page, 2);
    await page.screenshot({ path: `${outDir}metadata-preview.png` });
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 430, height: 932 },
    isMobile: true,
    hasTouch: true,
  });

  test("libraries-mobile.png", async ({ page }) => {
    await sampleLibrary(page);
    await signIn(page, "/libraries/7");
    await expect(page.getByText(SERIES[0].name, { exact: true })).toBeVisible();
    await waitForCovers(page, 2);
    await page.screenshot({ path: `${outDir}libraries-mobile.png` });
  });
});
