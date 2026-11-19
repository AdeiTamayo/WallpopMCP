import * as fs from "node:fs";
import * as path from "node:path";
import { apiRequest, type ApiRequestOptions, type ApiResponse } from "./httpClient.js";
import { config, hasCredentials } from "../config.js";
import { WallapopAuthError, WallapopError } from "../types.js";
import type { SessionData } from "../types.js";
import { browserClient, type LoginStepResult } from "../fallback/browserClient.js";
import { WEB_BASE } from "./httpClient.js";

/** Minimal surface of the browser client used for session renewal (mockable). */
export interface SessionBrowser {
  readExistingSession(): Promise<LoginStepResult | null>;
  seedCookies?(cookies: Record<string, string>): Promise<void>;
}

/** Margin before JWT expiry at which we renew proactively. Keycloak access tokens live ~5 min. */
const REFRESH_MARGIN_MS = 60_000;

export const RELOGIN_MESSAGE =
  "Wallapop session expired and could not be renewed automatically. A new login is needed: call login_start, then login_submit_code with the SMS code.";

/** NextAuth's /api/auth/session returns the Keycloak access token under `token` (also accept other spellings). */
export function tokenFromSessionJson(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const user = (o.user && typeof o.user === "object" ? o.user : {}) as Record<string, unknown>;
  for (const c of [o.token, o.accessToken, o.access_token, user.accessToken]) {
    if (typeof c === "string" && c.split(".").length === 3) return c;
  }
  return undefined;
}

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

  private refreshing: Promise<boolean> | null = null;
  private readonly request_: (opts: ApiRequestOptions) => Promise<ApiResponse>;
  private readonly browser_: SessionBrowser | null;

  /**
   * @param deps optional injection points (used by unit tests): the HTTP function and the browser
   *             session reader. Defaults: apiRequest and the shared browserClient.
   */
  constructor(
    private readonly file: string,
    deps: { request?: (opts: ApiRequestOptions) => Promise<ApiResponse>; browser?: SessionBrowser | null } = {}
  ) {
    this.request_ = deps.request ?? apiRequest;
    this.browser_ = deps.browser === undefined ? (browserClient.isEnabled() ? browserClient : null) : deps.browser;
  }

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
  private tokenIsFresh(): boolean {
    if (!this.session.accessToken) return false;
    const exp = decodeJwtExp(this.session.accessToken);
    return exp === undefined || exp > Date.now() + REFRESH_MARGIN_MS;
  }

  /**
   * Makes sure the stored session is usable, renewing the access token proactively when it is about to
   * expire. It NEVER starts an interactive login (that would send an SMS); if renewal fails it throws an
   * auth error asking for login_start / login_submit_code. WALLAPOP_AUTO_LOGIN=1 re-enables the legacy,
   * now-dead /api/v3/access/login endpoint.
   */
  async ensureFreshToken(): Promise<void> {
    if (this.tokenIsFresh()) return;
    if (Object.keys(this.session.cookies).length > 0 || this.session.refreshToken) {
      if (await this.refresh()) return;
    }
    if (config.autoLogin && hasCredentials() && (await this.login())) return;
    if (!this.session.accessToken && Object.keys(this.session.cookies).length === 0) {
      throw new WallapopAuthError(
        "Not authenticated. Run the login_start tool, then login_submit_code with the SMS code Wallapop sends, or import a cookies file with import_session_cookies."
      );
    }
    throw new WallapopAuthError(RELOGIN_MESSAGE);
  }

  /**
   * Authenticated API request: renews the token first if needed, and on a 401 renews once and retries
   * the request once. Never triggers a login.
   */
  async request(opts: ApiRequestOptions): Promise<ApiResponse> {
    await this.ensureFreshToken();
    try {
      return await this.request_({ ...opts, ...this.authHeaders() });
    } catch (err) {
      if (!(err instanceof WallapopAuthError)) throw err;
      if (!(await this.refresh("after-401"))) throw new WallapopAuthError(RELOGIN_MESSAGE);
      try {
        return await this.request_({ ...opts, ...this.authHeaders() });
      } catch (retryErr) {
        if (retryErr instanceof WallapopAuthError) throw new WallapopAuthError(RELOGIN_MESSAGE);
        throw retryErr;
      }
    }
  }

  /** Stores the result of a successful browser login / session read. */
  adopt(result: LoginStepResult): void {
    if (result.status !== "authenticated") return;
    this.dirty = true;
    if (result.cookies) this.session.cookies = { ...this.session.cookies, ...result.cookies };
    if (result.accessToken) {
      this.session.accessToken = result.accessToken;
      this.session.expiresAt = decodeJwtExp(result.accessToken) ?? result.expiresAt;
    } else if (result.expiresAt) this.session.expiresAt = result.expiresAt;
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
   * Renews the access token without credentials or SMS. Concurrent callers share one in-flight renewal.
   *  1. Fast path: GET es.wallapop.com/api/auth/session with the stored NextAuth cookies. NextAuth refreshes
   *     the Keycloak token server-side, returns it as `token` and rotates the session cookie (persisted).
   *  2. Fallback: the same endpoint inside the persistent browser profile (reusing the server's own Chrome
   *     context, so there is no profile-lock conflict), seeding it with the stored cookies if needed.
   * Returns true only when a non-expired access token was obtained.
   * @param mode "if-needed" (default): skip when the token is still fresh; "always": hit the session
   *             endpoint anyway (refresh_session tool); "after-401": the current token was rejected by the
   *             API, so only a different, non-expired token counts as success.
   */
  async refresh(mode: "if-needed" | "always" | "after-401" = "if-needed"): Promise<boolean> {
    if (mode === "if-needed" && this.tokenIsFresh()) return true;
    if (!this.refreshing) {
      const previous = this.session.accessToken;
      this.refreshing = this.doRefresh(mode === "after-401" ? previous : undefined).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private acceptToken(token: string | undefined, rejected?: string): boolean {
    if (!token || token === rejected) return false;
    const exp = decodeJwtExp(token);
    if (exp !== undefined && exp <= Date.now() + 5_000) return false;
    this.session.accessToken = token;
    this.session.expiresAt = exp;
    this.dirty = true;
    return true;
  }

  private async doRefresh(rejected?: string): Promise<boolean> {
    if (hasNextAuthCookie(this.session.cookies)) {
      try {
        const res = await this.request_({
          path: "/api/auth/session",
          baseUrl: WEB_BASE,
          cookies: this.session.cookies,
          headers: { Accept: "application/json" },
        });
        const setCookies = parseSetCookie(res.headers);
        if (Object.keys(setCookies).length > 0) {
          this.session.cookies = { ...this.session.cookies, ...setCookies };
          this.dirty = true;
        }
        const ok = this.acceptToken(tokenFromSessionJson(res.json) ?? setCookies.accessToken, rejected);
        if (ok && this.session.accessToken) this.session.cookies.accessToken = this.session.accessToken;
        this.persist();
        if (ok) return true;
      } catch {
        void 0;
      }
    }
    if (this.browser_) {
      try {
        let existing = await this.browser_.readExistingSession();
        if ((!existing || !this.isUsable(existing, rejected)) && this.browser_.seedCookies && hasNextAuthCookie(this.session.cookies)) {
          await this.browser_.seedCookies(this.session.cookies);
          existing = await this.browser_.readExistingSession();
        }
        if (existing && this.isUsable(existing, rejected)) {
          this.adopt(existing);
          return true;
        }
      } catch {
        void 0;
      }
    }
    if (this.session.refreshToken) {
      try {
        const res = await this.request_({
          method: "POST",
          path: "/api/v3/access/refresh",
          body: { refresh_token: this.session.refreshToken },
        });
        const body = (res.json ?? {}) as Record<string, unknown>;
        const data = (body.data ?? body) as Record<string, unknown>;
        const token = (data.token ?? data) as Record<string, unknown>;
        const accessToken = token.access_token ?? token.accessToken ?? data.access_token;
        const newRefresh = token.refresh_token ?? token.refreshToken ?? data.refresh_token;
        if (newRefresh) this.session.refreshToken = newRefresh as string;
        const ok = this.acceptToken(typeof accessToken === "string" ? accessToken : undefined, rejected);
        this.persist();
        return ok;
      } catch {
        return false;
      }
    }
    return false;
  }

  private isUsable(r: LoginStepResult, rejected?: string): boolean {
    if (r.status !== "authenticated" || !r.accessToken || r.accessToken === rejected) return false;
    const exp = decodeJwtExp(r.accessToken);
    return exp === undefined || exp > Date.now() + 5_000;
  }

  authHeaders(): { bearerToken?: string; cookies?: Record<string, string> } {
    const headers: { bearerToken?: string; cookies?: Record<string, string> } = {};
    if (this.session.accessToken) headers.bearerToken = this.session.accessToken;
    if (Object.keys(this.session.cookies).length > 0) headers.cookies = this.session.cookies;
    return headers;
  }
}