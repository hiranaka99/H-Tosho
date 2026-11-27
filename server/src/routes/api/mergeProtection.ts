import { Hono } from "hono";
import { errMsg } from "./helpers.js";
import { protectedMerge, ProtectedMergeError } from "../../merge/index.js";

export const api = new Hono();

api.post("/merge-protection/preview", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  try {
    const preview = await protectedMerge.preview(body);
    c.header("Cache-Control", "no-store");
    return c.json(preview);
  } catch (error) {
    return c.json(
      { error: errMsg(error) },
      error instanceof ProtectedMergeError ? error.status : 502
    );
  }
});
