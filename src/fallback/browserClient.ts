import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config } from "../config.js";
import { WallapopError, WallapopAuthError } from "../types.js";
import * as path from "node:path";
import * as fs from "node:fs";

interface CapturedResponse {
  url: string;
  json: unknown;
}

export class BrowserClient {
  private context: BrowserContext | null = null;
  private userDataDir = path.resolve(process.cwd(), ".wallapop-browser");

  isEnabled(): boolean {
    return config.browser !== "off";
  }

  cookies(): Record<string, string> {
    return this.sessionCookies;
  }

  private sessionCookies: Record<string, string> = {};

  async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context;
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const channels: string[] = [];
    if (config.browser === "auto") channels.push("chrome", "msedge");
    else if (config.browser === "chrome" || config.browser === "msedge") channels.push(config.browser);
    else channels.push("chromium");

    let lastError: Error | null = null;
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
        });
        return this.context;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new WallapopError(
      "Could not launch any browser for the Playwright fallback. Install Chrome or Edge, or set WALLAPOP_BROWSER. " +
        (lastError?.message ?? ""),
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

  async login(email: string, password: string): Promise<Record<string, string>> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    try {
      await page.goto("https://es.wallapop.com/auth/signin", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => void 0);
      await sleep(2000);
      await page.getByLabel(/email|correo/i).first().fill(email).catch(() => void 0);
      await page.locator('input[type="password"]').first().fill(password).catch(() => void 0);
      const submit = page.locator('button[type="submit"], form button').first();
      await submit.click().catch(() => void 0);
      await sleep(3000);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => void 0);
      await sleep(2000);

      const url = page.url();
      if (url.includes("mfa") || url.includes("verify") || /code|mfa/i.test(await page.content().then((h) => h.slice(0, 2000)))) {
        throw new WallapopAuthError("MFA challenge detected during browser login - complete it manually or import session cookies");
      }

      const cookies = await ctx.cookies("https://es.wallapop.com");
      const map: Record<string, string> = {};
      for (const c of cookies) map[c.name] = c.value;
      if (!map.accessToken && !map["__Secure-next-auth.session-token"]) {
        throw new WallapopAuthError("Browser login did not yield an authenticated session (could not find accessToken cookie)");
      }
      this.sessionCookies = map;
      return map;
    } finally {
      await page.close().catch(() => void 0);
    }
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