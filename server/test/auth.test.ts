import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "htosho-auth-"));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb } = await import("../src/db/index.js");
const { createApp } = await import("../src/app.js");

initDb();
const app = createApp();

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "response must set a session cookie");
  return value.split(";", 1)[0];
}

function json(method: string, body?: unknown, session?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: session } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test("first-time setup creates an authenticated session and closes setup", async () => {
  let response = await app.request("/api/auth/status");
  assert.deepEqual(await response.json(), {
    setupRequired: true,
    authenticated: false,
    username: null,
  });

  response = await app.request(
    "/api/auth/setup",
    json("POST", { username: "admin", password: "correct horse" })
  );
  assert.equal(response.status, 201);
  const session = cookie(response);

  response = await app.request("/api/auth/status", {
    headers: { cookie: session },
  });
  assert.deepEqual(await response.json(), {
    setupRequired: false,
    authenticated: true,
    username: "admin",
  });

  response = await app.request(
    "/api/auth/setup",
    json("POST", { username: "other", password: "another password" })
  );
  assert.equal(response.status, 409);
});

test("protected routes require login and password changes invalidate old credentials", async () => {
  let response = await app.request("/api/health");
  assert.equal(response.status, 401);

  response = await app.request(
    "/api/auth/login",
    json("POST", { username: "admin", password: "wrong password" })
  );
  assert.equal(response.status, 401);

  response = await app.request(
    "/api/auth/login",
    json("POST", { username: "admin", password: "correct horse" })
  );
  assert.equal(response.status, 200);
  const oldSession = cookie(response);

  response = await app.request("/api/health", {
    headers: { cookie: oldSession },
  });
  assert.equal(response.status, 200);

  response = await app.request(
    "/api/auth/credentials",
    json(
      "PUT",
      {
        currentPassword: "correct horse",
        username: "owner",
        password: "new secure password",
      },
      oldSession
    )
  );
  assert.equal(response.status, 200);
  const newSession = cookie(response);

  response = await app.request("/api/health", {
    headers: { cookie: oldSession },
  });
  assert.equal(response.status, 401);
  response = await app.request(
    "/api/auth/login",
    json("POST", { username: "admin", password: "correct horse" })
  );
  assert.equal(response.status, 401);
  response = await app.request(
    "/api/auth/login",
    json("POST", { username: "owner", password: "new secure password" })
  );
  assert.equal(response.status, 200);

  response = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { cookie: newSession },
  });
  assert.equal(response.status, 200);
  response = await app.request("/api/health", {
    headers: { cookie: newSession },
  });
  assert.equal(response.status, 401);
});

test("malformed JSON returns a client error instead of an internal failure", async () => {
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(
    login.status,
    401,
    "login handles its own malformed body without exposing internals"
  );

  const authenticated = await app.request(
    "/api/auth/login",
    json("POST", { username: "owner", password: "new secure password" })
  );
  const session = cookie(authenticated);
  const response = await app.request("/api/doujin/search", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: "{",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
});

test("authenticated API responses do not opt arbitrary origins into credentialed CORS", async () => {
  const authenticated = await app.request(
    "/api/auth/login",
    json("POST", { username: "owner", password: "new secure password" })
  );
  const session = cookie(authenticated);
  const response = await app.request("/api/health", {
    headers: { cookie: session, origin: "https://attacker.example" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
