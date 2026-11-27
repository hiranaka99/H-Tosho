import { expect, test, type Page } from "@playwright/test";
import type { NotificationSettings } from "../../../server/src/contracts/notifications";
import type { WatchedSearch } from "../../../server/src/contracts/following";

let originalSettings: NotificationSettings | undefined;
test.afterEach(async ({ page }, testInfo) => {
  await page.request.delete(`/api/__test/discord/${testInfo.project.name}`);
  if (originalSettings) {
    const current = (await (await page.request.get("/api/settings")).json())
      .notifications;
    expect(
      (
        await page.request.put("/api/settings/notifications", {
          data: {
            notifications: originalSettings,
            expectedRevision: current.revision,
          },
        })
      ).ok()
    ).toBeTruthy();
    originalSettings = undefined;
  }
});

async function runFixtureCheck(page: Page, id: number) {
  const response = await page.request.post("/api/watched-searches/check", {
    data: { watchIds: [id] },
  });
  expect(response.status()).toBe(202);
  const { id: jobId } = await response.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/jobs/${jobId}`)).json()).job.status
    )
    .toBe("completed");
  await page.reload();
  await page.getByRole("button", { name: /^Manage watches/ }).click();
  return jobId as number;
}

test("Following has no delivery log or digest settings while Discord and Task history still work", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const project = testInfo.project.name,
    query = `artist:e2e-discord-${project}`;
  const errors: string[] = [],
    acquisitions: string[] = [],
    deliveryRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      ["/api/downloads", "/api/downloads/merged"].includes(path)
    )
      acquisitions.push(path);
    if (path.startsWith("/api/watched-deliveries")) deliveryRequests.push(path);
  });
  await page.route("**/api/recommendations", (route) =>
    route.fulfill({
      json: {
        date: "2026-11-16",
        generatedAt: "2026-11-16T00:00:00Z",
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
  await page.route("**/api/downloads/library-matches", (route) =>
    route.fulfill({ json: { reports: [], warnings: [] } })
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
  originalSettings = (await (await page.request.get("/api/settings")).json())
    .notifications;
  await page.goto("/settings?tab=notifications");
  await expect(page.getByLabel("Daily time", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("IANA timezone", { exact: true })).toHaveCount(
    0
  );
  await page
    .getByRole("switch", { name: "Enable Discord notifications" })
    .check();
  await page
    .getByLabel("Discord webhook", { exact: true })
    .fill("https://discord.test/webhook/fixture");
  const saveBar = page.getByRole("region", { name: "Unsaved settings" });
  await saveBar
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    saveBar.getByText("All changes saved.", { exact: true })
  ).toBeVisible();
  const saved = (await (await page.request.get("/api/settings")).json())
    .notifications as NotificationSettings;
  expect(saved.discord.enabled).toBe(true);
  expect(saved).not.toHaveProperty("digest");
  // Keep draft testing in the UI without contacting an external webhook.
  await page.route("**/api/settings/notifications/test", (route) =>
    route.fulfill({ json: { discord: "ok" } })
  );
  await page
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect(
    page.getByText("Test notification sent to Discord.", { exact: true })
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/settings")).json()).notifications
  ).toEqual(saved);
  const settingsCard = page
    .getByRole("heading", { name: "Notifications", exact: true })
    .locator("..")
    .locator("..");
  await settingsCard.screenshot({
    path: testInfo.outputPath("discord-settings-light.png"),
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await settingsCard.screenshot({
    path: testInfo.outputPath("discord-settings-dark.png"),
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  expect(
    (
      await page.request.put("/api/settings/notifications", {
        data: {
          notifications: {
            ...saved,
            discord: {
              enabled: true,
              webhookUrl: `http://127.0.0.1:18787/__fixture/discord/${project}`,
            },
          },
          expectedRevision: saved.revision,
        },
      })
    ).ok()
  ).toBeTruthy();

  const added = await page.request.post("/api/watched-searches", {
    data: { source: "hitomi", query },
  });
  const watch = (await added.json()) as WatchedSearch;
  await page.goto("/downloader?tab=watched");
  await page.getByRole("button", { name: /^Manage watches/ }).click();
  await expect(
    page.getByRole("heading", { name: "Notification delivery", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Delivery status", exact: true })
  ).toHaveCount(0);
  const row = page.locator(`[data-watched-search-id="${watch.id}"]`);
  await row
    .getByRole("button", { name: `Edit watch ${query}`, exact: true })
    .click();
  const editor = row.getByRole("form");
  expect(
    await editor
      .getByLabel("Notification delivery", { exact: true })
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value)
      )
  ).toEqual(["in-app", "immediate"]);
  await editor
    .getByRole("button", { name: "Cancel edit", exact: true })
    .click();

  const seedId = await runFixtureCheck(page, watch.id);
  const checkId = await runFixtureCheck(page, watch.id);
  const checked = (
    await (await page.request.get(`/api/jobs/${checkId}`)).json()
  ).job;
  expect(checked.result.newGalleries).toBe(1);
  expect(checked.result.notified).toBe(1);
  expect(
    (
      await (
        await page.request.get(`/api/__test/discord/${project}/posts`)
      ).json()
    ).length
  ).toBe(1);
  // Check status and its Task link live on the Following page, beside the inbox.
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("link", { name: "View check", exact: true }).click();
  const task = page
    .getByRole("dialog")
    .or(page.getByRole("complementary", { name: "Task details" }));
  await expect(task).toContainText("1 Discord notifications sent");
  await expect(task).toContainText("Discord notification sent for");
  await expect(task.getByLabel("Following delivery status")).toHaveCount(0);
  await task.screenshot({
    path: testInfo.outputPath("following-task-history.png"),
    animations: "disabled",
  });
  await page.request.post(`/api/__test/discord/${project}/mode`, {
    data: { mode: "unknown" },
  });
  await page.goto("/downloader?tab=watched");
  const uncertainId = await runFixtureCheck(page, watch.id);
  const uncertain = (
    await (await page.request.get(`/api/jobs/${uncertainId}`)).json()
  ).job;
  expect(uncertain.result.failed).toBe(0);
  expect(uncertain.result.notificationUnknown).toBe(1);
  expect(uncertain.result.notified).toBe(0);
  expect(
    (await (await page.request.get(`/api/jobs/${seedId}`)).json()).job.status
  ).toBe("completed");
  expect(
    (await (await page.request.get(`/api/jobs/${checkId}`)).json()).job.result
  ).toEqual(checked.result);
  expect(
    await page
      .locator("main")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  expect(deliveryRequests).toEqual([]);
  expect(acquisitions).toEqual([]);
  expect(errors).toEqual([]);
});
