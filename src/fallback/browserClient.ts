import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { config } from "../config.js";
import { WallapopError, WallapopAuthError } from "../types.js";
import * as path from "node:path";
import * as fs from "node:fs";

export type LoginStepStatus = "authenticated" | "otp_required" | "error" | "pending";

export interface LoginStepResult {
  status: LoginStepStatus;
  /** Short human-readable explanation. Never contains secrets. */
  message: string;
  /** Visible text of the current login step (e.g. masked phone number), truncated. */
  pageHint?: string;
  /** Only set when status === "authenticated". Not to be echoed back to the user. */
  cookies?: Record<string, string>;
  accessToken?: string;
  expiresAt?: number;
}

const WEB_ORIGIN = "https://es.wallapop.com";
const KC_HOST = "accounts.wallapop.com";
const ONBOARDING_URL = WEB_ORIGIN + "/auth/onboarding";
const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  "input#otp",
  'input[name="otp"]',
  'input[name="code"]',
  'input[name="smsCode"]',
  'input[name*="otp" i]',
  'input[name*="code" i]:not([type="hidden"])',
  'input[inputmode="numeric"]:not([type="hidden"])',
];
const KC_ERROR_SELECTORS = [
  "#input-error",
  "#input-error-username",
  "#input-error-password",
  ".kc-feedback-text",
  '[class*="alert-error"]',
  '[class*="alert-warning"]',
  '[class*="error-message"]',
  '[id*="error" i]:not(input)',
  '[role="alert"]',
  '[aria-live="assertive"]',
];

function isSessionCookieName(name: string): boolean {
  return name === "accessToken" || /^(__Secure-)?next-auth\.session-token(\.\d+)?$/.test(name);
}

function pickAccessToken(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const candidates = [o.accessToken, o.access_token, o.token, (o.user as Record<string, unknown> | undefined)?.accessToken];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 20) return c;
    if (c && typeof c === "object") {
      const inner = pickAccessToken(c);
      if (inner) return inner;
    }
  }
  return undefined;
}

function jwtExpMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function sessionExpiry(json: unknown): number | undefined {
  const exp = json && typeof json === "object" ? (json as { expires?: unknown }).expires : undefined;
  if (typeof exp !== "string") return undefined;
  const t = Date.parse(exp);
  return Number.isFinite(t) ? t : undefined;
}

interface CapturedResponse {
  url: string;
  json: unknown;
}

export class BrowserClient {
  private context: BrowserContext | null = null;
  // Absolute path (was relative to process.cwd(), which is /workspace when launched by the MCP host).
  private userDataDir = config.browserProfileDir;
  private loginPage: Page | null = null;
  private loginStartedAt = 0;

  isEnabled(): boolean {
    return config.browser !== "off";
  }

  cookies(): Record<string, string> {
    return this.sessionCookies;
  }

  private sessionCookies: Record<string, string> = {};

  async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context;
    // Wallapop's CDN blocks headless Chrome, so we need a (possibly invisible) X display on Linux.
    if (process.platform === "linux" && !process.env.DISPLAY) {
      const sockets = fs.existsSync("/tmp/.X11-unix") ? fs.readdirSync("/tmp/.X11-unix").filter((f) => /^X\d+$/.test(f)) : [];
      if (sockets.length > 0) process.env.DISPLAY = ":" + sockets[0].slice(1);
    }
    fs.mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 });
    const channels: string[] = [];
    if (config.browser === "auto") channels.push("chrome", "msedge");
    else if (config.browser === "chrome" || config.browser === "msedge") channels.push(config.browser);
    else channels.push("chromium");

    let lastError: Error | null = null;
    const errors: string[] = [];
    for (const channel of channels) {
      try {
        this.context = await chromium.launchPersistentContext(this.userDataDir, {
          headless: false,
          channel: channel === "chromium" ? undefined : (channel as "chrome" | "msedge"),
          viewport: { width: 1280, height: 900 },
          locale: "es-ES",
          args: [
            "--window-position=-32000,-32000",
            "--window-size=1280,900",
            "--disable-blink-features=AutomationControlled",
          ],
        });
        this.context.on("close", () => {
          this.context = null;
          this.loginPage = null;
        });
        return this.context;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        errors.push(`${channel}: ${lastError.message.split("\n")[0]}`);
      }
    }
    const allErrors = errors.join(" | ");
    if (/ProcessSingleton|SingletonLock|profile.*in use|Target page, context or browser has been closed|exitCode=21/i.test(allErrors)) {
      throw new WallapopError(
        `Browser profile ${this.userDataDir} is locked by another Chrome process. Kill it (pgrep -f ${path.basename(this.userDataDir)}) and retry.`,
        "BROWSER_PROFILE_LOCKED"
      );
    }
    throw new WallapopError(
      "Could not launch any browser for the Playwright fallback. Install Chrome or Edge, or set WALLAPOP_BROWSER. " +
        allErrors,
      "BROWSER_UNAVAILABLE"
    );
  }

  private async captureResponses(page: Page, pattern: RegExp): Promise<CapturedResponse[]> {
    const captured: CapturedResponse[] = [];
    page.on("response", async (response) => {
      if (!pattern.test(response.url())) return;
      try {
        const body = await response.text();
        if (body) {
          const json = JSON.parse(body);
          captured.push({ url: response.url(), json });
        }
      } catch {
        void 0;
      }
    });
    return captured;
  }

  private async navigate(url: string, pattern: RegExp, timeoutMs = 30000): Promise<CapturedResponse[]> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    try {
      const captured = await this.captureResponses(page, pattern);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => void 0);
      await sleep(1500);
      return captured;
    } finally {
      await page.close().catch(() => void 0);
    }
  }

  async searchByKeywords(keywords: string): Promise<CapturedResponse[]> {
    const url = `https://es.wallapop.com/search?keywords=${encodeURIComponent(keywords)}`;
    return this.navigate(url, /api\.wallapop\.com\/api\/v3\/search\/(components|section)/);
  }

  async pageBySlug(slug: string, type: "item" | "user"): Promise<{ captured: CapturedResponse[]; html: string }> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    const pattern =
      type === "item"
        ? /api\.wallapop\.com\/api\/v3\/(items\/|item-detail)/
        : /api\.wallapop\.com\/api\/v3\/users\//;
    try {
      const captured = await this.captureResponses(page, pattern);
      await page.goto(`https://es.wallapop.com/${type === "item" ? "item" : "user"}/${slug}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      }).catch(() => void 0);
      await sleep(1000);
      const html = await page.content();
      return { captured, html };
    } finally {
      await page.close().catch(() => void 0);
    }
  }

  /** True while a login started with loginStart() is waiting for the SMS code. */
  hasPendingLogin(): boolean {
    return Boolean(this.loginPage && !this.loginPage.isClosed());
  }

  pendingLoginAgeSec(): number | null {
    return this.hasPendingLogin() ? Math.round((Date.now() - this.loginStartedAt) / 1000) : null;
  }

  async loginCancel(): Promise<void> {
    if (this.loginPage) await this.loginPage.close().catch(() => void 0);
    this.loginPage = null;
  }

  /**
   * Reads the NextAuth session of the persistent profile (no credentials sent, no SMS).
   * Returns the session cookies + access token if the profile is already logged in.
   */
  async readExistingSession(page?: Page): Promise<LoginStepResult | null> {
    const ctx = await this.ensure();
    const own = !page;
    const p = page ?? (await ctx.newPage());
    try {
      if (!p.url().startsWith(WEB_ORIGIN)) {
        await p.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 25000 });
      }
      const json = await p
        .evaluate(async () => {
          const r = await fetch("/api/auth/session", { credentials: "include", headers: { Accept: "application/json" } });
          return r.ok ? r.json().catch(() => null) : null;
        })
        .catch(() => null);
      const cookies = await this.wallapopCookies();
      const hasCookie = Object.keys(cookies).some(isSessionCookieName);
      const accessToken = pickAccessToken(json) ?? cookies.accessToken;
      const hasUser = Boolean(json && typeof json === "object" && Object.keys(json as object).length > 0);
      if (!hasUser && !accessToken && !hasCookie) return null;
      this.sessionCookies = cookies;
      return {
        status: "authenticated",
        message: "Wallapop session is active.",
        cookies,
        accessToken,
        expiresAt: jwtExpMs(accessToken) ?? sessionExpiry(json),
      };
    } finally {
      if (own) await p.close().catch(() => void 0);
    }
  }

  /**
   * Seeds the persistent profile with session cookies the server itself saved (e.g. a NextAuth session
   * cookie rotated by the HTTP refresh path), so the browser route uses the newest session.
   */
  async seedCookies(cookies: Record<string, string>): Promise<void> {
    const ctx = await this.ensure();
    const wanted = Object.entries(cookies).filter(([name]) => isSessionCookieName(name));
    if (wanted.length === 0) return;
    await ctx.addCookies(
      wanted.map(([name, value]) => ({
        name,
        value,
        domain: "es.wallapop.com",
        path: "/",
        secure: true,
        httpOnly: name !== "accessToken",
        sameSite: "Lax" as const,
      }))
    );
  }

  private async wallapopCookies(): Promise<Record<string, string>> {
    const ctx = await this.ensure();
    const map: Record<string, string> = {};
    for (const c of await ctx.cookies([WEB_ORIGIN, "https://api.wallapop.com"])) map[c.name] = c.value;
    return map;
  }

  private async visibleText(page: Page, max = 400): Promise<string> {
    // Includes text inside shadow roots (Wallapop's walla-* web components), which body.innerText misses.
    const t = await page
      .evaluate(() => {
        const out: string[] = [];
        const walk = (root: Node) => {
          for (const n of Array.from(root.childNodes)) {
            if (n.nodeType === Node.TEXT_NODE) {
              const v = (n.textContent ?? "").trim();
              const pe = n.parentElement;
              if (v && pe && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(pe.tagName) && pe.getClientRects().length > 0) out.push(v);
            } else if (n instanceof Element) {
              if (n.shadowRoot) walk(n.shadowRoot);
              walk(n);
            }
          }
        };
        walk(document.body);
        return out.join(" ");
      })
      .catch(() => "");
    return t.replace(/\s+/g, " ").trim().slice(0, max);
  }

  private async findOtpInputs(page: Page) {
    for (const sel of OTP_SELECTORS) {
      const loc = page.locator(sel);
      const n = await loc.count().catch(() => 0);
      if (n > 0 && (await loc.first().isVisible().catch(() => false))) return loc;
    }
    return null;
  }

  private async keycloakError(page: Page): Promise<string | null> {
    const found: string[] = [];
    for (const sel of KC_ERROR_SELECTORS) {
      const locs = page.locator(sel);
      const n = Math.min(await locs.count().catch(() => 0), 5);
      for (let i = 0; i < n; i++) {
        const loc = locs.nth(i);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const t = (await loc.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (t && !found.includes(t)) found.push(t.slice(0, 200));
      }
    }
    const invalid = await page
      .locator('[aria-invalid="true"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name || e.id).filter(Boolean))
      .catch(() => [] as string[]);
    if (invalid.length) found.push("invalid fields: " + invalid.join(","));
    return found.length ? found.join(" | ").slice(0, 500) : null;
  }

  /** Non-secret diagnostics about reCAPTCHA on the Keycloak page. */
  private async recaptchaInfo(page: Page): Promise<string> {
    return page
      .evaluate(() => {
        const tok = document.querySelector<HTMLInputElement>("#id-recaptcha-token, input[name=recaptchaToken]");
        const w = window as unknown as { grecaptcha?: unknown };
        const badge = document.querySelector(".grecaptcha-badge, iframe[src*='recaptcha']");
        const challenge = document.querySelector("iframe[src*='recaptcha'][src*='bframe'], iframe[title*='challenge' i]");
        return `recaptcha: lib=${Boolean(w.grecaptcha)} badge=${Boolean(badge)} tokenLen=${tok?.value?.length ?? -1} challenge=${Boolean(challenge)}`;
      })
      .catch(() => "recaptcha: n/a");
  }

  /** True when Keycloak shows the email/password form again (i.e. the POST was rejected). */
  private async isLoginFormShown(page: Page): Promise<boolean> {
    return (
      page.url().includes(KC_HOST) &&
      (await page.locator("input#password").isVisible().catch(() => false)) &&
      (await page.locator("input#username").isVisible().catch(() => false))
    );
  }

  /** Polls the login page until it lands back on es.wallapop.com, shows an OTP field, or shows an error. */
  private async waitForLoginOutcome(page: Page, budgetMs: number, otpAlreadyShown: boolean): Promise<LoginStepResult> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const url = page.url();
      if (url.startsWith(WEB_ORIGIN) && !url.includes("/auth/onboarding")) {
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => void 0);
        const existing = await this.readExistingSession(page);
        if (existing) return existing;
      }
      if (url.includes("/auth/onboarding") && url.includes("error=")) {
        return { status: "error", message: "Wallapop returned to onboarding with error: " + (new URL(url).searchParams.get("error") ?? "unknown") };
      }
      if (url.includes(KC_HOST)) {
        if (!otpAlreadyShown && (await this.findOtpInputs(page))) {
          return {
            status: "otp_required",
            message: "Wallapop sent a verification code by SMS. Call login_submit_code with it (the pending login stays open ~10 min).",
            pageHint: await this.visibleText(page),
          };
        }
        const err = await this.keycloakError(page);
        if (err) {
          return {
            status: "error",
            message: "Keycloak error: " + err + " [" + (await this.recaptchaInfo(page)) + "]",
            pageHint: await this.visibleText(page),
          };
        }
        if (!otpAlreadyShown && url.includes("login-actions/") && (await this.isLoginFormShown(page))) {
          // POSTed and the same form came back without a visible message: still a rejection.
          return {
            status: "error",
            message:
              "Keycloak re-displayed the email/password form after submit (credentials or reCAPTCHA rejected, no visible message). [" +
              (await this.recaptchaInfo(page)) +
              "]",
            pageHint: await this.visibleText(page),
          };
        }
      }
      await sleep(1000);
    }
    return {
      status: "pending",
      message: "No clear outcome yet. Call login_status to check again, or login_cancel.",
      pageHint: (page.url().split("?")[0] ?? "") + " :: " + (await this.visibleText(page, 300)),
    };
  }

  /**
   * Step 1 of the two-step login. Reuses an existing session if the persistent profile is already
   * logged in (no SMS). Otherwise opens Wallapop's Keycloak login, submits email+password and
   * returns "otp_required" as soon as the SMS-code screen appears. Stays below ~50 s so the MCP call
   * does not time out. The page is kept open for loginSubmitCode().
   */
  /** Resolves the visible, enabled Keycloak submit control (it lives inside <walla-button id="kc-login">'s shadow root). */
  private async resolveSubmit(page: Page): Promise<{ name: string; loc: Locator; info: string } | null> {
    const candidates: Array<[string, Locator]> = [
      ["role=button[name~=Acceder]", page.getByRole("button", { name: /acceder/i })],
      ["walla-button#kc-login >> button", page.locator("walla-button#kc-login button")],
      ['button[type="submit"]', page.locator('button[type="submit"]')],
      ["#kc-login", page.locator("#kc-login")],
    ];
    for (const [name, all] of candidates) {
      const n = Math.min(await all.count().catch(() => 0), 5);
      for (let i = 0; i < n; i++) {
        const loc = all.nth(i);
        const visible = await loc.isVisible().catch(() => false);
        const enabled = await loc.isEnabled().catch(() => false);
        if (!visible || !enabled) continue;
        const covered = await loc
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            const x = r.x + r.width / 2;
            const y = r.y + r.height / 2;
            let hit: Element | null = document.elementFromPoint(x, y);
            while (hit && hit.shadowRoot) {
              const deeper = hit.shadowRoot.elementFromPoint(x, y);
              if (!deeper || deeper === hit) break;
              hit = deeper;
            }
            const host = (el.getRootNode() as ShadowRoot).host ?? null;
            const ok = Boolean(hit && (el === hit || el.contains(hit) || (host && (host === hit || host.contains(hit)))));
            return { ok, hit: hit ? `${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : ""}` : "none", inViewport: y > 0 && y < innerHeight };
          })
          .catch(() => ({ ok: false, hit: "eval-failed", inViewport: false }));
        const info = `${name}[${i}] visible=${visible} enabled=${enabled} centerHit=${covered.hit} notCovered=${covered.ok} inViewport=${covered.inViewport}`;
        return { name, loc, info };
      }
    }
    return null;
  }

  private async dismissConsent(page: Page, timeoutMs: number): Promise<boolean> {
    const consent = page
      .locator('a:has-text("Aceptar todo"), button:has-text("Aceptar todo"), #onetrust-accept-btn-handler, button:has-text("Aceptar y cerrar")')
      .first();
    try {
      await consent.waitFor({ state: "visible", timeout: timeoutMs });
      await consent.click({ timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Step 1 of the two-step login. Reuses an existing session if the persistent profile is already
   * logged in (no SMS). Otherwise opens Wallapop's Keycloak login, types email+password and submits
   * once, returning "otp_required" as soon as the SMS-code screen appears. Every step has its own
   * short timeout and name so a failure says exactly where it stopped. Stays below ~50 s.
   */
  async loginStart(email: string, password: string, budgetMs = 48000, dryRun = false): Promise<LoginStepResult> {
    const t0 = Date.now();
    await this.loginCancel();
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    this.loginPage = page;
    this.loginStartedAt = Date.now();
    const left = () => Math.max(1000, budgetMs - (Date.now() - t0));
    const tmo = (ms: number) => Math.min(ms, left());
    const trail: string[] = [];
    let currentStep = "init";
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      currentStep = name;
      const s0 = Date.now();
      const r = await fn();
      trail.push(`${name}:${Date.now() - s0}ms`);
      return r;
    };
    // Network trace of the Keycloak form POST (method, path and status only; no bodies, no query values).
    const net: string[] = [];
    let posted = false;
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.hostname === KC_HOST && req.method() === "POST" && u.pathname.includes("login-actions")) {
        posted = true;
        net.push(`POST ${u.pathname}`);
      }
    });
    page.on("response", (res) => {
      const u = new URL(res.url());
      if (u.hostname === KC_HOST && res.request().method() === "POST" && u.pathname.includes("login-actions")) {
        net.push(`-> ${res.status()}`);
      }
    });
    const diag = () => `steps=[${trail.join(", ")}] net=[${net.join(" ")}] t=${Date.now() - t0}ms`;
    try {
      await step("goto-onboarding", () => page.goto(ONBOARDING_URL, { waitUntil: "domcontentloaded", timeout: tmo(20000) }));
      const existing = await step("check-existing-session", () => this.readExistingSession(page));
      if (existing) {
        await this.loginCancel();
        return { ...existing, message: "Already logged in (persistent browser profile); no SMS needed." };
      }
      if (!page.url().includes("/auth/onboarding")) {
        await step("goto-onboarding-2", () => page.goto(ONBOARDING_URL, { waitUntil: "domcontentloaded", timeout: tmo(15000) }));
      }
      await step("consent-onboarding", () => this.dismissConsent(page, 5000));
      const emailBtn = page.getByRole("button", { name: /iniciar sesi.n con (e-?mail|correo)/i }).first();
      await step("click-login-with-email", async () => {
        await emailBtn.waitFor({ state: "visible", timeout: tmo(12000) });
        await emailBtn.click({ timeout: tmo(8000) });
      });
      await step("wait-keycloak", () => page.waitForURL((u) => u.hostname === KC_HOST, { timeout: tmo(15000) }));
      const user = page.locator("input#username");
      const pass = page.locator("input#password");
      await step("wait-username-field", () => user.waitFor({ state: "visible", timeout: tmo(12000) }));
      await step("wait-page-ready", async () => {
        await page.waitForLoadState("load", { timeout: tmo(8000) }).catch(() => void 0);
        await page
          .waitForFunction(() => Boolean((window as unknown as { grecaptcha?: unknown }).grecaptcha), undefined, { timeout: tmo(6000) })
          .catch(() => void 0);
      });
      await step("consent-keycloak", () => this.dismissConsent(page, 1500));
      const submit = await step("resolve-submit", () => this.resolveSubmit(page));
      if (dryRun) {
        const rc = await this.recaptchaInfo(page);
        const formAction = await page.locator("form").first().getAttribute("action").catch(() => null);
        await this.loginCancel();
        return {
          status: submit ? "pending" : "error",
          message:
            (submit
              ? "Dry run OK: reached the Keycloak form. Nothing was typed or submitted."
              : "Dry run: Keycloak form reached but no visible+enabled submit control found.") +
            ` [submit: ${submit?.info ?? "none"}; ${rc}; form action ${(formAction ?? "").split("?")[0]}; credentials loaded: email ${email.length} chars, password ${password.length} chars; ${diag()}]`,
        };
      }
      if (!submit) throw new Error("no visible+enabled submit control");

      const jitter = () => 60 + Math.floor(Math.random() * 90);
      await step("type-username", async () => {
        await user.focus({ timeout: tmo(5000) });
        await user.fill("", { timeout: tmo(5000) });
        await user.pressSequentially(email, { delay: jitter(), timeout: tmo(15000) });
      });
      await sleep(300 + Math.floor(Math.random() * 500));
      await step("type-password", async () => {
        await pass.focus({ timeout: tmo(5000) });
        await pass.fill("", { timeout: tmo(5000) });
        await pass.pressSequentially(password, { delay: jitter(), timeout: tmo(15000) });
      });
      const typedUserOk = (await user.inputValue()) === email;
      const typedPassLen = (await pass.inputValue()).length;
      if (!typedUserOk || typedPassLen !== password.length) {
        await this.loginCancel();
        return {
          status: "error",
          message: `Form fields did not keep the typed values (username ok=${typedUserOk}, password length ${typedPassLen}/${password.length}). Nothing submitted. ${diag()}`,
        };
      }
      await sleep(500 + Math.floor(Math.random() * 500));

      // Submit exactly once: try the resolved button, then Enter, then form.requestSubmit(),
      // moving to the next method only if no POST to Keycloak was observed.
      const waitPosted = async (ms: number) => {
        const end = Date.now() + ms;
        while (!posted && Date.now() < end) await sleep(200);
        return posted;
      };
      const methods: Array<[string, () => Promise<unknown>]> = [
        [`click(${submit.name})`, () => submit.loc.click({ timeout: tmo(6000), noWaitAfter: true })],
        ["press-enter", () => pass.press("Enter", { timeout: tmo(4000), noWaitAfter: true })],
        [
          "form.requestSubmit",
          () =>
            page.evaluate(() => {
              const f = document.querySelector<HTMLFormElement>("form[action*='login-actions']") ?? document.querySelector("form");
              if (!f) throw new Error("no form");
              f.requestSubmit();
            }),
        ],
      ];
      const submitErrors: string[] = [];
      await step("submit", async () => {
        for (const [name, run] of methods) {
          try {
            await run();
          } catch (e) {
            submitErrors.push(`${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
          }
          if (await waitPosted(8000)) {
            trail.push(`submitted-by=${name}`);
            return;
          }
          submitErrors.push(`${name}: no POST observed`);
        }
        throw new Error("form was not submitted: " + submitErrors.join(" | "));
      });
      await page.waitForLoadState("domcontentloaded", { timeout: tmo(15000) }).catch(() => void 0);
      await sleep(1500);
      currentStep = "wait-outcome";
      const outcome = await this.waitForLoginOutcome(page, left(), false);
      outcome.message += ` ${diag()}`;
      if (outcome.status === "authenticated" || outcome.status === "error") await this.loginCancel();
      return outcome;
    } catch (err) {
      const hint = await this.visibleText(page, 300).catch(() => "");
      await this.loginCancel();
      throw new WallapopAuthError(
        `Browser login failed at step "${currentStep}" (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). ${diag()} Page: ${hint}`
      );
    }
  }

  /** Step 2: type the SMS code into the pending Keycloak page and wait for the redirect back to Wallapop. */
  async loginSubmitCode(code: string, budgetMs = 45000): Promise<LoginStepResult> {
    const page = this.loginPage;
    if (!page || page.isClosed()) {
      throw new WallapopAuthError("No pending login. Call login_start first.");
    }
    const digits = code.replace(/\s+/g, "");
    const inputs = await this.findOtpInputs(page);
    if (!inputs) {
      // Maybe it already moved on (e.g. user approved elsewhere).
      return this.waitForLoginOutcome(page, 5000, true);
    }
    const n = await inputs.count();
    if (n > 1 && n === digits.length) {
      for (let i = 0; i < n; i++) await inputs.nth(i).fill(digits[i]);
    } else {
      await inputs.first().fill(digits);
    }
    const submit = await this.resolveSubmit(page);
    let done = false;
    if (submit) done = await submit.loc.click({ timeout: 6000, noWaitAfter: true }).then(() => true, () => false);
    if (!done) await inputs.first().press("Enter", { timeout: 4000, noWaitAfter: true }).catch(() => void 0);
    const outcome = await this.waitForLoginOutcome(page, budgetMs, true);
    if (outcome.status === "authenticated") await this.loginCancel();
    return outcome;
  }

  async loginStatus(): Promise<LoginStepResult> {
    const page = this.loginPage;
    if (!page || page.isClosed()) {
      const existing = await this.readExistingSession();
      return existing ?? { status: "error", message: "No pending login and no active session." };
    }
    return this.waitForLoginOutcome(page, 3000, true);
  }

  private async heartLabel(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const h = document.querySelector('[aria-label*="favorit" i], [aria-label*="Guardar" i], [aria-label*="Eliminar" i]');
      return h?.getAttribute("aria-label") ?? null;
    });
  }

  private async detectHeart(page: Page): Promise<{ x: number; y: number } | null> {
    return page.evaluate(() => {
      const h = document.querySelector('[aria-label*="favorit" i], [aria-label*="Guardar" i], [aria-label*="Eliminar" i]');
      if (!h) return null;
      h.scrollIntoView({ block: "center", behavior: "instant" });
      const r = h.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  }

  async favorite(itemUrl: string, wantFavorite: boolean): Promise<{ state: "done" | "already" | "not_found" | "error" }> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    let result: "done" | "already" | "not_found" | "error" = "error";
    try {
      outer: for (let attempt = 1; attempt <= 4; attempt++) {
        await page.goto(itemUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => void 0);
        await sleep(6000);
        const banner = page.locator('button:has-text("Aceptar"), button:has-text("Acepto"), button:has-text("Accept all")').first();
        if (await banner.count()) await banner.click({ force: true }).catch(() => void 0);

        const label = await this.heartLabel(page);
        if (label === null) {
          const gone = await page.locator("text=ya no est\u00e1 disponible").count();
          result = gone > 0 ? "not_found" : "error";
          continue;
        }
        const isFavorited = /eliminar/i.test(label);
        if (isFavorited === wantFavorite) {
          result = "already";
          break;
        }
        for (let i = 0; i < 6; i++) {
          const pos = await this.detectHeart(page);
          if (pos) {
            await page.mouse.click(pos.x, pos.y);
            await sleep(3000);
            const after = await this.heartLabel(page);
            if (after && /eliminar/i.test(after) === wantFavorite) {
              result = "done";
              break outer;
            }
          } else {
            await sleep(4000);
          }
        }
      }
    } finally {
      await page.close().catch(() => void 0);
    }
    return { state: result };
  }

  async removeFromFavoritesGrid(ref: string): Promise<{ state: "done" | "already" | "not_found" | "error" }> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    const numeric = /(\d+)$/.exec(ref)?.[1] ?? null;
    const slug = ref.split("/").filter(Boolean).pop() ?? ref;
    let result: "done" | "already" | "not_found" | "error" = "error";
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await page.goto("https://es.wallapop.com/app/favorites", { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => void 0);
        await sleep(3000);
        const matched = await page.evaluate(
          ({ numeric, slug }) => {
            const anchor = Array.from(document.querySelectorAll("a[href*='/item/']")).find((a) => {
              const href = a.getAttribute("href") ?? "";
              if (numeric && href.endsWith("-" + numeric)) return true;
              return href.includes("/item/" + slug);
            });
            return anchor ? (anchor.closest("li")?.outerHTML ?? "") : "";
          },
          { numeric, slug }
        );
        if (!matched) {
          result = "not_found";
          break;
        }
        await page.evaluate(({ numeric, slug }) => {
          const anchor = Array.from(document.querySelectorAll("a[href*='/item/']")).find((a) => {
            const href = a.getAttribute("href") ?? "";
            if (numeric && href.endsWith("-" + numeric)) return true;
            return href.includes("/item/" + slug);
          });
          const card = anchor?.closest("li");
          const btn = card?.querySelector("button[class*='RetrievalItemCard__favorite']") as HTMLButtonElement | null;
          btn?.click();
        }, { numeric, slug });
        await sleep(4000);
        const stillThere = await page.evaluate(
          ({ numeric, slug }) =>
            Array.from(document.querySelectorAll("a[href*='/item/']")).some((a) => {
              const href = a.getAttribute("href") ?? "";
              if (numeric && href.endsWith("-" + numeric)) return true;
              return href.includes("/item/" + slug);
            }),
          { numeric, slug }
        );
        if (!stillThere) {
          result = "done";
          break;
        }
      }
    } finally {
      await page.close().catch(() => void 0);
    }
    return { state: result };
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => void 0);
      this.context = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const browserClient = new BrowserClient();