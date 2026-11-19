import * as fs from "node:fs";
import * as path from "node:path";
import { apiRequest } from "./httpClient.js";
import { config, hasCredentials } from "../config.js";
import { WallapopAuthError, WallapopError } from "../types.js";
import type { SessionData } from "../types.js";
import { browserClient, type LoginStepResult } from "../fallback/browserClient.js";
import { WEB_BASE } from "./httpClient.js";

function hasNextAuthCookie(cookies: Record<string, string>): boolean {
  return Object.keys(cookies).some((n) => /^(__Secure-)?next-auth\.session-token(\.\d+)?$/.test(n));
}

function decodeJwtExp(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function parseSetCookie(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const line of raw.length > 0 ? raw : [headers.get("set-cookie") ?? ""]) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) cookies[name] = value;
    }
  }
  return cookies;
}

export class SessionManager {
  session: SessionData = { cookies: {} };
  dirty = false;

  constructor(private readonly file: string) {}

  load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
        this.session = { cookies: (raw.cookies as Record<string, string>) ?? {} };
        if (typeof raw.accessToken === "string") this.session.accessToken = raw.accessToken;
        if (typeof raw.refreshToken === "string") this.session.refreshToken = raw.refreshToken;
        if (typeof raw.expiresAt === "number") this.session.expiresAt = raw.expiresAt;
      }
    } catch {
      this.session = { cookies: {} };
    }
    if (config.cookiesFile) this.importCookiesFile(config.cookiesFile);
    if (Object.keys(browserClient.cookies()).length > 0) {
      this.session.cookies = { ...this.session.cookies, ...browserClient.cookies() };
    }
  }

  importCookiesFile(file: string): void {
    try {
      const imported = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{
        name?: string;
        value?: string;
      }>;
      for (const c of imported) {
        if (c.name && c.value !== undefined) this.session.cookies[c.name] = c.value;
        if (c.name === "accessToken") this.session.accessToken = c.value;
      }
      this.dirty = true;
      this.persist();
    } catch {
      throw new WallapopError(`Could not parse cookies file: ${file}`, "COOKIES_FILE");
    }
  }

  persist(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ ...this.session, cookies: this.session.cookies }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      void 0;
    }
    this.dirty = false;
  }

  isAuthenticated(): boolean {
    return Boolean(this.session.accessToken) || Object.keys(this.session.cookies).length > 0;
  }

  getSession(): SessionData {
    return this.session;
  }

  /**
   * Makes sure the stored session is usable. It NEVER starts an interactive login on its own any more:
   * Wallapop's login is Keycloak + SMS code, so an automatic login on every tool call would send an SMS
   * each time. Use the login_start / login_submit_code tools instead (or set WALLAPOP_AUTO_LOGIN=1 for the
   * legacy, now-dead /api/v3/access/login endpoint).
   */
  async ensureFreshToken(): Promise<void> {
    if (this.session.accessToken) {
      const exp = decodeJwtExp(this.session.accessToken);
      if (exp === undefined || exp > Date.now() + 60000) return;
    }
    if (Object.keys(this.session.cookies).length > 0 || this.session.refreshToken) {
      if (await this.refresh()) return;
    }
    if (config.autoLogin && hasCredentials() && (await this.login())) return;
    if (Object.keys(this.session.cookies).length > 0) return;
    throw new WallapopAuthError(
      "Not authenticated (or session expired). Run the login_start tool, then login_submit_code with the SMS code Wallapop sends, or import a cookies file with import_session_cookies."
    );
  }

  /** Stores the result of a successful browser login / session read. */
  adopt(result: LoginStepResult): void {
    if (result.status !== "authenticated") return;
    this.dirty = true;
    if (result.cookies) this.session.cookies = { ...this.session.cookies, ...result.cookies };
    if (result.accessToken) this.session.accessToken = result.accessToken;
    if (result.expiresAt) this.session.expiresAt = result.expiresAt;
    this.persist();
  }

  /** Legacy API login. Wallapop retired this endpoint (it answers 400 with an empty body). Only used when WALLAPOP_AUTO_LOGIN=1. */
  async login(): Promise<boolean> {
    if (!config.email || !config.password) return false;
    try {
      const res = await apiRequest({
        method: "POST",
        path: "/api/v3/access/login",
        body: { username: config.email, password: config.password },
      });
      const body = res.json as Record<string, unknown>;
      const data = (body.data ?? body) as Record<string, unknown>;
      const token = (data.token ?? data) as Record<string, unknown>;
      const accessToken =
        token.access_token ?? token.accessToken ?? data.access_token ?? this.session.cookies.accessToken;
      const refreshToken = token.refresh_token ?? token.refreshToken ?? data.refresh_token;
      const expiresIn = token.expires_in ?? token.expiresIn ?? data.expires_in;
      const setCookies = parseSetCookie(res.headers);
      const hasSessionCookie = Boolean(setCookies.accessToken || (Object.keys(setCookies).length && !accessToken));
      this.dirty = true;
      if (accessToken) this.session.accessToken = accessToken as string;
      if (refreshToken) this.session.refreshToken = refreshToken as string;
      if (expiresIn) this.session.expiresAt = Date.now() + (expiresIn as number) * 1000;
      if (Object.keys(setCookies).length > 0) {
        if (setCookies.accessToken) this.session.accessToken = setCookies.accessToken;
        this.session.cookies = { ...this.session.cookies, ...setCookies };
      }
      this.persist();
      return Boolean(accessToken || hasSessionCookie);
    } catch (err) {
      if (err instanceof WallapopError) {
        throw new WallapopAuthError(
          `Legacy API login failed (${err.message}). Wallapop now uses Keycloak + SMS: use login_start / login_submit_code.`
        );
      }
      throw err;
    }
  }

  /**
   * Refresh without credentials: ask the Wallapop web app (NextAuth) for the current session using the
   * stored session cookies. NextAuth refreshes the Keycloak token server-side and returns it. No SMS.
   */
  async refresh(): Promise<boolean> {
    if (hasNextAuthCookie(this.session.cookies)) {
      try {
        const res = await apiRequest({
          path: "/api/auth/session",
          baseUrl: WEB_BASE,
          cookies: this.session.cookies,
          headers: { Accept: "application/json" },
        });
        const json = (res.json ?? {}) as Record<string, unknown>;
        const setCookies = parseSetCookie(res.headers);
        const token =
          (typeof json.accessToken === "string" && json.accessToken) ||
          (typeof json.access_token === "string" && json.access_token) ||
          (typeof (json.user as Record<string, unknown> | undefined)?.accessToken === "string" &&
            ((json.user as Record<string, unknown>).accessToken as string)) ||
          undefined;
        if (Object.keys(setCookies).length > 0) {
          this.session.cookies = { ...this.session.cookies, ...setCookies };
          this.dirty = true;
        }
        if (token) {
          this.session.accessToken = token;
          this.session.expiresAt = decodeJwtExp(token);
          this.dirty = true;
        }
        this.persist();
        if (token || Object.keys(json).length > 0) return true;
      } catch {
        void 0;
      }
      // Fall back to the persistent browser profile (it may hold a fresher Keycloak SSO session).
      if (browserClient.isEnabled()) {
        const existing = await browserClient.readExistingSession().catch(() => null);
        if (existing) {
          this.adopt(existing);
          return true;
        }
      }
      return false;
    }
    if (!this.session.refreshToken) return false;
    try {
      const res = await apiRequest({
        method: "POST",
        path: "/api/v3/access/refresh",
        body: { refresh_token: this.session.refreshToken },
      });
      const body = res.json as Record<string, unknown>;
      const data = (body.data ?? body) as Record<string, unknown>;
      const token = (data.token ?? data) as Record<string, unknown>;
      const accessToken = token.access_token ?? token.accessToken ?? data.access_token;
      this.dirty = true;
      if (accessToken) this.session.accessToken = accessToken as string;
      const newRefresh = token.refresh_token ?? token.refreshToken ?? data.refresh_token;
      if (newRefresh) this.session.refreshToken = newRefresh as string;
      this.persist();
      return Boolean(accessToken);
    } catch {
      return false;
    }
  }

  authHeaders(): { bearerToken?: string; cookies?: Record<string, string> } {
    const headers: { bearerToken?: string; cookies?: Record<string, string> } = {};
    if (this.session.accessToken) headers.bearerToken = this.session.accessToken;
    if (Object.keys(this.session.cookies).length > 0) headers.cookies = this.session.cookies;
    return headers;
  }
}