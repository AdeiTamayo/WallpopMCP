import { apiRequest } from "./httpClient.js";
import { WallapopApiError } from "../types.js";
import type { OrderBy, ItemSummary } from "../types.js";

const PAGE_SIZE = 40;

export interface SearchOptions {
  keywords: string;
  categoryId?: number;
  minPrice?: number;
  maxPrice?: number;
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
  orderBy?: OrderBy;
  nextPage?: string;
  maxResults?: number;
}

export interface SearchResultOutcome {
  items: ItemSummary[];
  nextPage?: string;
  searchId?: string;
  total?: number;
}

function get(obj: unknown, path: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else cur = (cur as Record<string, unknown>)[key as string];
  }
  return cur;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function pickText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object")
    return String(get(v, ["original"]) ?? get(v, ["value"]) ?? "");
  return "";
}

function pickPrice(item: Record<string, unknown>): { amount: number; currency: string } {
  const cash = get(item, ["price", "cash"]) as Record<string, unknown> | undefined;
  const amount =
    cash && typeof cash.amount === "number" ? cash.amount : get(item, ["price", "amount"]);
  const currency =
    cash && typeof cash.currency === "string" ? cash.currency : get(item, ["price", "currency"]);
  return {
    amount: typeof amount === "number" ? amount : 0,
    currency: typeof currency === "string" ? currency : "EUR",
  };
}

function pickFirstImage(item: Record<string, unknown>): string | undefined {
  const imgs = get(item, ["images"]);
  if (!Array.isArray(imgs) || imgs.length === 0) return undefined;
  const first = imgs[0] as Record<string, unknown> | null;
  const urls = get(first, ["urls"]) as Record<string, unknown> | undefined;
  if (urls) return String(urls.big ?? urls.medium ?? urls.small ?? "");
  return String((first as Record<string, unknown>).url ?? "");
}

function normalizeSummary(item: Record<string, unknown>): ItemSummary {
  const price = pickPrice(item);
  const webSlug = String(get(item, ["web_slug"]) ?? get(item, ["slug"]) ?? get(item, ["webSlug"]) ?? "");
  const loc = get(item, ["location"]) as Record<string, unknown> | undefined;
  const shipping = get(item, ["shipping"]) as Record<string, unknown> | undefined;
  const createdAt = get(item, ["created_at"]) ?? get(item, ["createdAt"]);
  const modifiedAt = get(item, ["modified_at"]) ?? get(item, ["modifiedAt"]);
  return {
    id: String(get(item, ["id"]) ?? ""),
    title: pickText(get(item, ["title"])),
    price: price.amount,
    currency: price.currency,
    imageUrl: pickFirstImage(item) || undefined,
    webSlug: webSlug || undefined,
    city: loc && typeof loc.city === "string" ? loc.city : undefined,
    reserved: asBool(get(item, ["reserved"])),
    favorited: asBool(get(item, ["favorited"])),
    shipping: shipping
      ? {
          itemIsShippable: asBool(
            get(shipping, ["item_is_shippable"]) ?? get(shipping, ["isItemShippable"])
          ),
          userAllowsShipping: asBool(
            get(shipping, ["user_allows_shipping"]) ?? get(shipping, ["isShippingAllowedByUser"])
          ),
        }
      : undefined,
    createdAt: typeof createdAt === "number" ? createdAt : undefined,
    modifiedAt: typeof modifiedAt === "number" ? modifiedAt : undefined,
    categoryId: typeof get(item, ["category_id"]) === "number" ? (get(item, ["category_id"]) as number) : undefined,
    sellerId: String(get(item, ["user_id"]) ?? get(item, ["userId"]) ?? ""),
    condition: typeof get(item, ["condition"]) === "string" ? (get(item, ["condition"]) as string) : null,
    url: webSlug ? `https://es.wallapop.com/item/${webSlug}` : undefined,
  };
}

function extractItems(payload: unknown): ItemSummary[] {
  const items = get(payload, ["data", "section", "items"]);
  const arr = Array.isArray(items) && items.length > 0 ? items : get(payload, ["search_objects"]);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map(normalizeSummary);
}

function findSearchResults(components: unknown[]): Record<string, unknown> | undefined {
  for (const c of components) {
    if (c === null || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    if (obj.type === "search_results" && obj.type_data && typeof obj.type_data === "object") {
      return obj.type_data as Record<string, unknown>;
    }
    if (obj.components && Array.isArray(obj.components)) {
      const nested = findSearchResults(obj.components);
      if (nested) return nested;
    }
  }
  return undefined;
}

function queryParamsOf(payload: unknown): { searchId?: string; total?: number } {
  const components = get(payload, ["components"]);
  if (!Array.isArray(components)) return {};
  const typeData = findSearchResults(components);
  if (!typeData) return {};
  const qp = get(typeData, ["query_params"]) as Record<string, unknown> | undefined;
  const searchId = typeof get(qp, ["search_id"]) === "string" ? (get(qp, ["search_id"]) as string) : undefined;
  const total =
    typeof get(qp, ["total"]) === "number"
      ? (get(qp, ["total"]) as number)
      : typeof get(typeData, ["total"]) === "number"
        ? (get(typeData, ["total"]) as number)
        : undefined;
  return { searchId, total };
}

function makeCursor(searchId: string, nextPage: string): string {
  return Buffer.from(JSON.stringify({ sid: searchId, np: nextPage })).toString("base64url");
}

function parseCursor(nextPage: string): { sid: string; np: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(nextPage, "base64url").toString("utf8"));
    if (typeof parsed.sid === "string" && typeof parsed.np === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function searchProducts(opts: SearchOptions): Promise<SearchResultOutcome> {
  const maxResults = opts.maxResults ?? PAGE_SIZE;
  const cursor = opts.nextPage ? parseCursor(opts.nextPage) : null;
  const commonQuery: Record<string, string | number | undefined> = {
    keywords: opts.keywords,
    category_id: opts.categoryId,
    min_sale_price: opts.minPrice,
    max_sale_price: opts.maxPrice,
    order_by: opts.orderBy,
    latitude: opts.latitude,
    longitude: opts.longitude,
    distance_in_km: opts.distanceKm,
    search_country: "ES",
  };
  let searchId: string | undefined = cursor?.sid;
  if (!searchId) {
    const componentsPayload = await apiRequest({
      path: "/api/v3/search/components",
      query: { ...commonQuery, source: "search_box" },
    });
    const { searchId: sid, total } = queryParamsOf(componentsPayload.json);
    if (!sid) {
      throw new WallapopApiError("Could not obtain search_id from Wallapop search components", componentsPayload.status);
    }
    searchId = sid;
  }
  const collected: ItemSummary[] = [];
  let nextPage: string | undefined = cursor?.np;
  let total: number | undefined;
  for (let page = 0; page < Math.ceil(maxResults / PAGE_SIZE) + 1; page++) {
    const sectionPayload = await apiRequest({
      path: "/api/v3/search/section",
      query: {
        ...commonQuery,
        search_id: searchId,
        section_type: "organic_search_results",
        source: "deep_link",
        next_page: nextPage,
      },
    });
    const items = extractItems(sectionPayload.json);
    for (const item of items) {
      if (item.reserved) continue;
      if (!collected.some((x) => x.id === item.id)) collected.push(item);
    }
    if (total === undefined) {
      const t = get(sectionPayload.json, ["data", "section", "total"]);
      total = typeof t === "number" ? t : undefined;
    }
    const rawNext = get(sectionPayload.json, ["meta", "next_page"]);
    nextPage = typeof rawNext === "string" && rawNext.length > 0 ? rawNext : undefined;
    if (!nextPage || collected.length >= maxResults) break;
  }
  return {
    items: collected.slice(0, maxResults),
    nextPage: nextPage && searchId ? makeCursor(searchId, nextPage) : undefined,
    searchId,
    total,
  };
}

export function buildSearchUrl(opts: {
  keywords?: string;
  categoryId?: number;
  minPrice?: number;
  maxPrice?: number;
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
  orderBy?: OrderBy;
}): string {
  const qs = new URLSearchParams();
  if (opts.keywords) qs.set("keywords", opts.keywords);
  if (opts.categoryId) qs.set("category_id", String(opts.categoryId));
  if (opts.minPrice !== undefined) qs.set("min_sale_price", String(opts.minPrice));
  if (opts.maxPrice !== undefined) qs.set("max_sale_price", String(opts.maxPrice));
  if (opts.latitude !== undefined) qs.set("latitude", String(opts.latitude));
  if (opts.longitude !== undefined) qs.set("longitude", String(opts.longitude));
  if (opts.distanceKm !== undefined) qs.set("distance_in_km", String(opts.distanceKm));
  if (opts.orderBy) qs.set("order_by", opts.orderBy);
  return `https://es.wallapop.com/app/search?${qs.toString()}`;
}