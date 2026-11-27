import { Hono } from "hono";
import { connectedClient, errMsg } from "./helpers.js";
import {
  MergeProtectionError,
  parseMergeProtectionRequest,
  resolveMergeProtection,
} from "../../services/mergeProtection.js";

export const api = new Hono();
api.post("/merge-protection/preview", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  const body: unknown = await c.req.json().catch(() => null);
  try {
    const result = await resolveMergeProtection(
      client,
      parseMergeProtectionRequest(body)
    );
    c.header("Cache-Control", "no-store");
    return c.json(result.preview);
  } catch (error) {
    return c.json(
      { error: errMsg(error) },
      error instanceof MergeProtectionError ? error.status : 502
    );
  }
});
