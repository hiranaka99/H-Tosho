import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.route("**/api/recommendations", (route) =>
    route.fulfill({
      json: {
        date: "2026-11-25",
        generatedAt: "2026-11-25T00:00:00Z",
        mode: "popular",
        profile: { artists: [], tags: [], series: [], language: null },
        items: [],
        repeatedCount: 0,
        degradedReason: null,
        ownedKeys: [],
        dismissedKeys: [],
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
}

test("Docker image replacement warning is surfaced in sidebar and Settings with copyable commands", async ({
  page,
}) => {
  await page.route("**/api/app-update/status", (route) =>
    route.fulfill({
      json: {
        currentVersion: "4.2.0",
        nodeVersion: "22.22.0",
        installMode: "docker",
        repo: "hiranaka99/H-Tosho",
        checkedAt: "2026-11-25T12:00:00Z",
        checkError: null,
        updateAvailable: true,
        latestRelease: {
          version: "4.3.0",
          tagName: "v4.3.0",
          name: "v4.3.0",
          publishedAt: "2026-11-25T10:00:00Z",
          htmlUrl: "https://github.com/hiranaka99/H-Tosho/releases/tag/v4.3.0",
          notes: "Upgraded base image and native SQLite bindings.",
          hasBundle: true,
          bundleSize: 2_500_000,
        },
        canUpdateInApp: false,
        unavailableReason: null,
        activeWork: { jobs: 0, downloads: 0 },
        docker: {
          requiresImageReplacement: true,
          reasons: [
            {
              code: "dockerfile-changed",
              summary:
                "The Dockerfile, base image, or system packages changed in this release.",
            },
            {
              code: "runtime-deps-changed",
              summary:
                "Server runtime dependencies or native modules (such as better-sqlite3) changed in this release.",
            },
          ],
          pullCommand: "docker compose pull && docker compose up -d",
          buildCommand: "git pull && docker compose up -d --build",
          dataDirectory: "/data",
          runningBundledOverlay: false,
          baseImageVersion: "4.2.0",
        },
        progress: {
          phase: "idle",
          message: "",
          targetVersion: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          bytesReceived: null,
          bytesTotal: null,
        },
        rolledBackVersion: null,
      },
    })
  );

  await signIn(page);

  const toggle = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  const sidebarNotice = page.getByRole("link", {
    name: /v4\.3\.0 · Replace image/,
  });
  await expect(sidebarNotice).toBeVisible();
  await sidebarNotice.click();

  await expect(
    page.getByRole("heading", { name: "App updates", exact: true })
  ).toBeVisible();
  const card = page.locator("#app-updates");
  await expect(
    card.getByText("Docker image must be completely replaced", { exact: true })
  ).toBeVisible();
  await expect(
    card.getByText(
      "The Dockerfile, base image, or system packages changed in this release."
    )
  ).toBeVisible();
  await expect(
    card.getByText(
      "Server runtime dependencies or native modules (such as better-sqlite3) changed in this release."
    )
  ).toBeVisible();
  await expect(card.getByText("docker compose down -v")).toBeVisible();
  await expect(
    card.getByText("docker compose pull && docker compose up -d")
  ).toBeVisible();
  await expect(
    card.getByText("git pull && docker compose up -d --build")
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Update to v4.3.0", exact: true })
  ).toHaveCount(0);
  expect(
    await page
      .locator("main")
      .evaluate((el) => el.scrollWidth <= el.clientWidth)
  ).toBeTruthy();
});

test("Compatible in-app update confirms before applying and displays progress", async ({
  page,
}) => {
  let appliedVersion: string | null = null;
  let phase: "idle" | "downloading" = "idle";

  const makePayload = () => ({
    currentVersion: "4.2.0",
    nodeVersion: "22.22.0",
    installMode: "docker",
    repo: "hiranaka99/H-Tosho",
    checkedAt: "2026-11-25T12:00:00Z",
    checkError: null,
    updateAvailable: true,
    latestRelease: {
      version: "4.3.0",
      tagName: "v4.3.0",
      name: "v4.3.0",
      publishedAt: "2026-11-25T10:00:00Z",
      htmlUrl: "https://github.com/hiranaka99/H-Tosho/releases/tag/v4.3.0",
      notes: "Faster search and minor fixes.",
      hasBundle: true,
      bundleSize: 1_500_000,
    },
    canUpdateInApp: true,
    unavailableReason: null,
    activeWork: { jobs: 0, downloads: 0 },
    docker: {
      requiresImageReplacement: false,
      reasons: [],
      pullCommand: "docker compose pull && docker compose up -d",
      buildCommand: "git pull && docker compose up -d --build",
      dataDirectory: "/data",
      runningBundledOverlay: false,
      baseImageVersion: "4.2.0",
    },
    progress:
      phase === "idle"
        ? {
            phase: "idle",
            message: "",
            targetVersion: null,
            startedAt: null,
            finishedAt: null,
            error: null,
            bytesReceived: null,
            bytesTotal: null,
          }
        : {
            phase: "downloading",
            message: "Downloading v4.3.0…",
            targetVersion: "4.3.0",
            startedAt: "2026-11-25T12:01:00Z",
            finishedAt: null,
            error: null,
            bytesReceived: 750_000,
            bytesTotal: 1_500_000,
          },
    rolledBackVersion: null,
  });

  await page.route("**/api/app-update/status", (route) =>
    route.fulfill({ json: makePayload() })
  );
  await page.route("**/api/app-update/apply", async (route) => {
    const body = route.request().postDataJSON() as { targetVersion?: string };
    appliedVersion = body.targetVersion ?? null;
    phase = "downloading";
    await route.fulfill({ status: 202, json: makePayload() });
  });

  await signIn(page);

  const toggle = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("link", { name: /Update available · v4\.3\.0/ }).click();

  const card = page.locator("#app-updates");
  await expect(
    card.getByText("Docker image must be completely replaced")
  ).toHaveCount(0);
  await card.getByText("Release notes", { exact: true }).click();
  await expect(card.getByText("Faster search and minor fixes.")).toBeVisible();

  await card
    .getByRole("button", { name: "Update to v4.3.0", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Update H-Tosho to v4.3.0?" })
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Update to v4.3.0", exact: true })
    .click();

  await expect.poll(() => appliedVersion).toBe("4.3.0");
  await expect(
    card.getByText("Downloading v4.3.0…", { exact: true })
  ).toBeVisible();
  await expect(
    card.getByRole("progressbar", { name: "App update progress" })
  ).toBeVisible();
});
