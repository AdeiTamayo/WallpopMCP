import { searchProducts, buildSearchUrl, type SearchOptions, type SearchResultOutcome } from "./client/search.js";
import { getListingById, normalizeListingDetail } from "./client/items.js";
import { getSellerById, normalizeSeller } from "./client/users.js";
import { listCategories } from "./client/categories.js";
import { scrapePage, firstOf } from "./fallback/ssrScrape.js";
import { browserClient } from "./fallback/browserClient.js";
import { WallapopBlockedError, WallapopError } from "./types.js";
import type { ListingDetail, SellerInfo, Category, ApiResult, ItemSummary } from "./types.js";

export function dedupeAndRankSearchResults(items: ItemSummary[]): ItemSummary[] {
  const bestByKey = new Map<string, ItemSummary>();

  for (const item of items) {
    const candidate = { ...item };
    const key = String(candidate.id || candidate.webSlug || candidate.url || candidate.title || "").trim().toLowerCase();
    if (!key) continue;

    const existing = bestByKey.get(key);
    if (!existing || scoreItem(candidate) > scoreItem(existing)) {
      bestByKey.set(key, candidate);
    }
  }

  return [...bestByKey.values()].sort((a, b) => {
    const diff = scoreItem(b) - scoreItem(a);
    if (diff !== 0) return diff;
    if (Number.isFinite(a.price) && Number.isFinite(b.price)) return a.price - b.price;
    return a.title.localeCompare(b.title);
  });
}

function scoreItem(item: ItemSummary): number {
  let score = 0;
  if (!item.reserved) score += 35;
  if (item.shipping?.itemIsShippable && item.shipping.userAllowsShipping) score += 65;
  if (item.imageUrl) score += 10;
  if (item.city) score += 5;
  if (item.price > 0) score += Math.max(0, 100 - item.price / 10);
  if (item.favorited) score += 8;
  return score;
}

export function memoize<TArgs extends readonly unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: { ttlMs?: number; cache?: Map<string, { expiresAt: number; value: TResult }>; keyFn?: (...args: TArgs) => string } = {}
): (...args: TArgs) => Promise<TResult> {
  const ttlMs = options.ttlMs ?? 15000;
  const cache = options.cache ?? new Map<string, { expiresAt: number; value: TResult }>();
  const keyFn = options.keyFn ?? ((...args: TArgs) => JSON.stringify(args));

  return async (...args: TArgs): Promise<TResult> => {
    const key = keyFn(...args);
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const value = await fn(...args);
    cache.set(key, { expiresAt: now + ttlMs, value });
    return value;
  };
}

function normalizeSearchPayload(json: unknown): { items: unknown[]; nextPage?: unknown; searchId?: unknown; total?: unknown } {
  const payload = json as Record<string, unknown>;
  let items: unknown[] = [];
  let nextPage: unknown;
  let searchId: unknown;
  let total: unknown;
  const deep = (obj: Record<string, unknown>): void => {
    if (Array.isArray(obj.items) && obj.items.length > 0) items = obj.items;
    if (Array.isArray(obj.search_objects) && obj.search_objects.length > 0) items = obj.search_objects;
    if (typeof obj.next_page === "string") nextPage = obj.next_page;
    if (typeof obj.search_id === "string") searchId = obj.search_id;
    if (typeof obj.total === "number") total = obj.total;
    if (typeof obj.type_data === "object" && obj.type_data !== null) deep(obj.type_data as Record<string, unknown>);
    if (typeof obj.query_params === "object" && obj.query_params !== null) deep(obj.query_params as Record<string, unknown>);
    if (typeof obj.section === "object" && obj.section !== null) deep(obj.section as Record<string, unknown>);
    if (typeof obj.data === "object" && obj.data !== null) deep(obj.data as Record<string, unknown>);
    if (typeof obj.meta === "object" && obj.meta !== null) deep(obj.meta as Record<string, unknown>);
    if (typeof obj.search_results === "object" && obj.search_results !== null) deep(obj.search_results as Record<string, unknown>);
  };
  deep(payload);
  return { items, nextPage, searchId, total };
}

export class HybridClient {
  private readonly listingCache = new Map<string, { expiresAt: number; value: ApiResult<ListingDetail> }>();
  private readonly sellerCache = new Map<string, { expiresAt: number; value: ApiResult<SellerInfo> }>();

  async search(opts: SearchOptions): Promise<ApiResult<SearchResultOutcome>> {
    try {
      const outcome = await searchProducts(opts);
      return { data: { ...outcome, items: dedupeAndRankSearchResults(outcome.items) }, source: "api" };
    } catch (err) {
      if (err instanceof WallapopBlockedError && browserClient.isEnabled()) {
        const captured = await browserClient.searchByKeywords(opts.keywords);
        for (const resp of captured) {
          const parsed = normalizeSearchPayload(resp.json);
          if (parsed.items.length > 0) {
            return {
              data: {
                items: dedupeAndRankSearchResults(
                  parsed.items
                    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
                    .map(normalizeListingDetail)
                ),
                nextPage: typeof parsed.nextPage === "string" && parsed.nextPage.length > 0 ? parsed.nextPage : undefined,
                searchId: typeof parsed.searchId === "string" ? parsed.searchId : undefined,
                total: typeof parsed.total === "number" ? parsed.total : undefined,
              },
              source: "browser",
            };
          }
        }
        return { data: { items: [] }, source: "browser" };
      }
      throw err;
    }
  }

  async listing(ref: string): Promise<ApiResult<ListingDetail>> {
    const normalizedKey = `listing:${String(ref).trim().toLowerCase()}`;
    const cached = this.listingCache.get(normalizedKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const isUrl = /^https?:\/\//.test(ref);
    const path = isUrl ? new URL(ref).pathname : ref;
    const slug = path.split("/").filter(Boolean).pop() ?? path;
    const numeric = /^\d+$/.test(slug);
    const looksLikeApiId = !numeric && /^[a-zA-Z0-9]{8,14}$/.test(slug) && !slug.includes("-");

    const retryable = (err: unknown): boolean =>
      err instanceof WallapopBlockedError ||
      (err as { status?: number }).status === 404 ||
      (err as { status?: number }).status === 500 ||
      (err as { status?: number }).status === 0;

    let result: ApiResult<ListingDetail> | undefined;
    if (numeric || looksLikeApiId) {
      try {
        const detail = await getListingById(slug);
        result = { data: detail, source: "api" };
      } catch (err) {
        if (!retryable(err)) throw err;
      }
    }

    if (!result) {
      let page: Awaited<ReturnType<typeof scrapePage>> | null = null;
      try {
        page = await scrapePage(`/item/${slug}`);
      } catch {
        page = null;
      }
      if (page) {
        const raw = firstOf(page.props, ["item", "listing", "product"]);
        if (raw) {
          result = { data: normalizeListingDetail(raw), source: "ssr" };
        }
      }
    }

    if (!result && browserClient.isEnabled()) {
      const { captured, html } = await browserClient.pageBySlug(slug, "item");
      for (const resp of captured) {
        const payload = resp.json as Record<string, unknown>;
        const rawData = (payload.data ?? payload) as Record<string, unknown> | null;
        if (rawData && typeof rawData === "object" && "id" in rawData) {
          result = { data: normalizeListingDetail(rawData), source: "browser" };
          break;
        }
      }
      if (!result) {
        const pageProps = extractNextDataFromHtml(html);
        const rawHtml = firstOf(pageProps ?? {}, ["item", "listing"]);
        if (rawHtml) result = { data: normalizeListingDetail(rawHtml), source: "browser" };
      }
    }

    if (!result) {
      throw new WallapopError(
        `Listing ${slug} could not be retrieved (API failed, SSR empty, browser fallback unavailable).`,
        "LISTING_NOT_FOUND"
      );
    }

    this.listingCache.set(normalizedKey, { expiresAt: Date.now() + 60000, value: result });
    return result;
  }

  async seller(ref: string): Promise<ApiResult<SellerInfo>> {
    const normalizedKey = `seller:${String(ref).trim().toLowerCase()}`;
    const cached = this.sellerCache.get(normalizedKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const seller = await getSellerById(ref);
      const result = { data: seller, source: "api" as const };
      this.sellerCache.set(normalizedKey, { expiresAt: Date.now() + 60000, value: result });
      return result;
    } catch (err) {
      const blocked =
        err instanceof WallapopBlockedError ||
        (err as { status?: number }).status === 404 ||
        (err as { status?: number }).status === 400 ||
        (err as { status?: number }).status === 0;
      if (!blocked) throw err;
      try {
        const page = await scrapePage(`/user/${ref}`);
        const raw = firstOf(page.props, ["user", "userProfile", "profile", "seller", "userInfo"]);
        if (raw) {
          const result = { data: normalizeSeller({ ...raw, userStats: page.props.userStats }), source: "ssr" as const };
          this.sellerCache.set(normalizedKey, { expiresAt: Date.now() + 60000, value: result });
          return result;
        }
      } catch {
        void 0;
      }
      if (browserClient.isEnabled()) {
        const { captured, html } = await browserClient.pageBySlug(ref, "user");
        for (const resp of captured) {
          const payload = resp.json as Record<string, unknown>;
          const rawData = (payload.data ?? payload.user ?? payload) as Record<string, unknown> | null;
          if (rawData && typeof rawData === "object" && "id" in rawData) {
            const result = { data: normalizeSeller(rawData), source: "browser" as const };
            this.sellerCache.set(normalizedKey, { expiresAt: Date.now() + 60000, value: result });
            return result;
          }
        }
        const pageProps = extractNextDataFromHtml(html);
        const rawHtml = firstOf(pageProps ?? {}, ["user", "userProfile", "profile", "seller"]);
        if (rawHtml) {
          const result = { data: normalizeSeller(rawHtml), source: "browser" as const };
          this.sellerCache.set(normalizedKey, { expiresAt: Date.now() + 60000, value: result });
          return result;
        }
        throw err;
      }
      throw err;
    }
  }

  async categories(): Promise<ApiResult<Category[]>> {
    try {
      const cats = await listCategories();
      return { data: cats, source: "api" };
    } catch (err) {
      if (err instanceof WallapopBlockedError && browserClient.isEnabled()) {
        const captured = await browserClient.searchByKeywords("");
        for (const resp of captured) {
          const payload = resp.json as Record<string, unknown>;
          const cats = payload.categories ?? (payload.data as unknown);
          if (Array.isArray(cats)) {
            return { data: cats as Category[], source: "browser" };
          }
        }
      }
      throw err;
    }
  }
}

function extractNextDataFromHtml(html: string): Record<string, unknown> | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    const props = data.props as Record<string, unknown>;
    return props && typeof props === "object" ? ((props.pageProps ?? props) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const hybrid = new HybridClient();
export { buildSearchUrl };