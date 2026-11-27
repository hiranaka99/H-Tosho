import { Hono } from "hono";
import {
  AppUpdateError,
  appUpdateManager,
  type AppUpdateManager,
} from "../../services/appUpdate.js";

export function createAppUpdateRoutes(
  manager: AppUpdateManager = appUpdateManager
): Hono {
  const router = new Hono();

  router.get("/app-update/status", async (c) => {
    const force = c.req.query("refresh") === "1";
    const status = await manager.getStatus({ force });
    return c.json(status, 200, { "Cache-Control": "private, no-store" });
  });

  router.post("/app-update/check", async (c) => {
    const status = await manager.getStatus({ force: true });
    return c.json(status, 200, { "Cache-Control": "private, no-store" });
  });

  router.post("/app-update/apply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetVersion?: unknown;
    } | null;
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const targetVersion = body?.targetVersion;
    if (targetVersion !== undefined && typeof targetVersion !== "string") {
      return c.json({ error: "targetVersion must be a string" }, 400);
    }
    try {
      const status = await manager.startUpdate(targetVersion);
      return c.json(status, 202, { "Cache-Control": "private, no-store" });
    } catch (error) {
      if (error instanceof AppUpdateError) {
        return c.json({ error: error.message }, error.status, {
          "Cache-Control": "private, no-store",
        });
      }
      throw error;
    }
  });

  router.post("/app-update/dismiss-rollback", (c) => {
    manager.dismissRollbackNotice();
    return c.json({ ok: true }, 200, { "Cache-Control": "private, no-store" });
  });

  return router;
}

export const api = createAppUpdateRoutes();
