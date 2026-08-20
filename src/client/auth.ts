import * as fs from "node:fs";
import * as path from "node:path";
import { apiRequest } from "./httpClient.js";
import { config, hasCredentials } from "../config.js";
import { WallapopAuthError, WallapopError } from "../types.js";
import type { SessionData } from "../types.js";
import { browserClient } from "../fallback/browserClient.js";

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
      "utf8"
    );
    this.dirty = false;
  }

  isAuthenticated(): boolean {
    return Boolean(this.session.accessToken) || Object.keys(this.session.cookies).length > 0;
  }

  getSession(): SessionData {
    return this.session;
  }

  async ensureFreshToken(): Promise<void> {
    if (this.session.accessToken) {
      const exp = decodeJwtExp(this.session.accessToken);
      if (exp === undefined || exp > Date.now() + 60000) return;
      if (this.session.refreshToken && (await this.refresh())) return;
    }
    if (hasCredentials() && (await this.login())) return;
    if (Object.keys(this.session.cookies).length > 0) return;
    throw new WallapopAuthError(
      "Not authenticated. Set WALLAPOP_EMAIL/WALLAPOP_PASSWORD, provide a cookies file, or run browser login."
    );
  }

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
      if (accessToken || hasSessionCookie) return true;
      return false;
    } catch (err) {
      if (err instanceof WallapopError) {
        if (browserClient.isEnabled()) {
          try {
            const cookies = await browserClient.login(config.email, config.password);
            this.dirty = true;
            if (cookies.accessToken) this.session.accessToken = cookies.accessToken;
            this.session.cookies = { ...this.session.cookies, ...cookies };
            this.persist();
            return true;
          } catch (browserErr) {
            if (browserErr instanceof WallapopAuthError) throw browserErr;
          }
        }
        throw new WallapopAuthError(`Login failed: ${err.message}`);
      }
      throw err;
    }
  }

  async refresh(): Promise<boolean> {
    if (!this.session.refreshToken && !this.session.cookies["__Secure-next-auth.session-token"]) return false;
    try {
      const res = await apiRequest({
        method: "POST",
        path: "/api/v3/access/refresh",
        body: this.session.refreshToken ? { refresh_token: this.session.refreshToken } : undefined,
        cookies: this.session.refreshToken ? undefined : this.session.cookies,
      });
      const body = res.json as Record<string, unknown>;
      const data = (body.data ?? body) as Record<string, unknown>;
      const token = (data.token ?? data) as Record<string, unknown>;
      const accessToken = token.access_token ?? token.accessToken ?? data.access_token;
      const setCookies = parseSetCookie(res.headers);
      this.dirty = true;
      if (accessToken) this.session.accessToken = accessToken as string;
      if (setCookies.accessToken) {
        this.session.accessToken = setCookies.accessToken;
        this.session.cookies = { ...this.session.cookies, ...setCookies };
      }
      const newRefresh = token.refresh_token ?? token.refreshToken ?? data.refresh_token;
      if (newRefresh) this.session.refreshToken = newRefresh as string;
      this.persist();
      return Boolean(accessToken || setCookies.accessToken);
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