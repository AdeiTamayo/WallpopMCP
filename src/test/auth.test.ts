import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, RELOGIN_MESSAGE, tokenFromSessionJson, type SessionBrowser } from "../client/auth.js";
import type { ApiRequestOptions, ApiResponse } from "../client/httpClient.js";
import { WallapopAuthError } from "../types.js";

function jwt(expSecFromNow: number, tag = "x"): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b({ exp: Math.floor(Date.now() / 1000) + expSecFromNow, tag })}.sig`;
}

function res(status: number, json: unknown, setCookies: string[] = []): ApiResponse {
  const headers = new Headers();
  for (const c of setCookies) headers.append("set-cookie", c);
  return { status, json, text: JSON.stringify(json), headers, url: "mock" };
}

function tmpSession(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-auth-"));
  const file = path.join(dir, "session.json");
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

const SESSION_COOKIE = "__Secure-next-auth.session-token";

test("tokenFromSessionJson reads NextAuth's `token` field", () => {
  const t = jwt(300);
  assert.equal(tokenFromSessionJson({ user: [], token: t, idToken: jwt(300, "id") }), t);
  assert.equal(tokenFromSessionJson({ user: [] }), undefined);
});

test("401 -> refresh via /api/auth/session -> retry once with the new token; rotated cookie persisted", async () => {
  const oldTok = jwt(200, "old");
  const newTok = jwt(300, "new");
  const file = tmpSession({ cookies: { [SESSION_COOKIE]: "s1", accessToken: oldTok }, accessToken: oldTok });
  const calls: string[] = [];
  let inboxCalls = 0;
  const request = async (o: ApiRequestOptions): Promise<ApiResponse> => {
    calls.push(o.path);
    if (o.path === "/api/auth/session") {
      assert.equal(o.cookies?.[SESSION_COOKIE], "s1");
      return res(200, { user: [], token: newTok }, [`${SESSION_COOKIE}=s2; Path=/; Secure; HttpOnly`]);
    }
    inboxCalls++;
    if (o.bearerToken === oldTok) throw new WallapopAuthError("Authentication failed (401)");
    assert.equal(o.bearerToken, newTok);
    return res(200, { ok: true });
  };
  const s = new SessionManager(file, { request, browser: null });
  s.load();
  const r = await s.request({ path: "/bff/messaging/inbox" });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(inboxCalls, 2);
  assert.deepEqual(calls, ["/bff/messaging/inbox", "/api/auth/session", "/bff/messaging/inbox"]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.accessToken, newTok);
  assert.equal(saved.cookies[SESSION_COOKIE], "s2");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("token about to expire is renewed proactively before the request", async () => {
  const oldTok = jwt(20, "old");
  const newTok = jwt(300, "new");
  const file = tmpSession({ cookies: { [SESSION_COOKIE]: "s1" }, accessToken: oldTok });
  const calls: string[] = [];
  const request = async (o: ApiRequestOptions): Promise<ApiResponse> => {
    calls.push(o.path);
    if (o.path === "/api/auth/session") return res(200, { token: newTok });
    assert.equal(o.bearerToken, newTok);
    return res(200, {});
  };
  const s = new SessionManager(file, { request, browser: null });
  s.load();
  await s.request({ path: "/api/v3/user/items/favorited" });
  assert.deepEqual(calls, ["/api/auth/session", "/api/v3/user/items/favorited"]);
});

test("HTTP refresh fails -> falls back to browser profile session", async () => {
  const oldTok = jwt(200, "old");
  const newTok = jwt(300, "browser");
  const file = tmpSession({ cookies: { [SESSION_COOKIE]: "s1" }, accessToken: oldTok });
  let browserReads = 0;
  const browser: SessionBrowser = {
    async readExistingSession() {
      browserReads++;
      return { status: "authenticated", message: "ok", accessToken: newTok, cookies: { [SESSION_COOKIE]: "s3" } };
    },
  };
  const request = async (o: ApiRequestOptions): Promise<ApiResponse> => {
    if (o.path === "/api/auth/session") return res(200, {}); // NextAuth could not renew
    if (o.bearerToken !== newTok) throw new WallapopAuthError("401");
    return res(200, { ok: 1 });
  };
  const s = new SessionManager(file, { request, browser });
  s.load();
  const r = await s.request({ path: "/bff/messaging/inbox" });
  assert.deepEqual(r.json, { ok: 1 });
  assert.equal(browserReads, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cookies[SESSION_COOKIE], "s3");
});

test("refresh impossible -> clear relogin error, request retried at most once, no login attempted", async () => {
  const oldTok = jwt(200, "old");
  const file = tmpSession({ cookies: { [SESSION_COOKIE]: "s1" }, accessToken: oldTok });
  let apiCalls = 0;
  const request = async (o: ApiRequestOptions): Promise<ApiResponse> => {
    if (o.path === "/api/auth/session") return res(200, { token: oldTok }); // same (rejected) token
    if (o.path.includes("access/login")) throw new Error("must never log in");
    apiCalls++;
    throw new WallapopAuthError("401");
  };
  const s = new SessionManager(file, { request, browser: null });
  s.load();
  await assert.rejects(s.request({ path: "/bff/messaging/inbox" }), (e: Error) => e.message === RELOGIN_MESSAGE);
  assert.equal(apiCalls, 1);
});

test("concurrent requests share a single in-flight refresh", async () => {
  const oldTok = jwt(10, "old");
  const newTok = jwt(300, "new");
  const file = tmpSession({ cookies: { [SESSION_COOKIE]: "s1" }, accessToken: oldTok });
  let sessionCalls = 0;
  const request = async (o: ApiRequestOptions): Promise<ApiResponse> => {
    if (o.path === "/api/auth/session") {
      sessionCalls++;
      await new Promise((r) => setTimeout(r, 30));
      return res(200, { token: newTok });
    }
    return res(200, {});
  };
  const s = new SessionManager(file, { request, browser: null });
  s.load();
  await Promise.all([s.request({ path: "/a" }), s.request({ path: "/b" }), s.request({ path: "/c" })]);
  assert.equal(sessionCalls, 1);
});
