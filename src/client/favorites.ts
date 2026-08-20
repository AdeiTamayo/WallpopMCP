import { apiRequest } from "./httpClient.js";
import { WallapopError } from "../types.js";
import type { SessionManager } from "./auth.js";
import { scrapePage, firstOf } from "../fallback/ssrScrape.js";

interface FavoriteItem {
  id: string;
  webSlug?: string;
  title?: string;
}

const API_ID_RE = /^[a-z0-9]{8,16}$/i;

function extractNumericSuffix(ref: string): string | null {
  const path = /^https?:\/\//.test(ref) ? new URL(ref).pathname : ref;
  const seg = path.split("/").filter(Boolean).pop() ?? path;
  const m = seg.match(/(\d+)$/);
  return m ? m[1] : null;
}

function slugPart(ref: string): string {
  const path = /^https?:\/\//.test(ref) ? new URL(ref).pathname : ref;
  return path.split("/").filter(Boolean).pop() ?? path;
}

async function fetchFavorites(session: SessionManager): Promise<FavoriteItem[]> {
  const res = await apiRequest({
    path: "/api/v3/user/items/favorited",
    query: { query: "", order_by: "newest", page_size: 100 },
    ...session.authHeaders(),
  });
  const payload = res.json as Record<string, unknown> | null;
  const arr = (payload?.data ?? payload?.items ?? []) as Array<Record<string, unknown>>;
  return arr
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map((it) => ({
      id: String(it.id ?? it.item_id ?? ""),
      webSlug:
        typeof it.slug === "string"
          ? it.slug
          : typeof it.web_slug === "string"
            ? it.web_slug
            : typeof it.webSlug === "string"
              ? it.webSlug
              : undefined,
      title: typeof it.title === "string" ? it.title : undefined,
    }));
}

export async function resolveApiId(session: SessionManager, ref: string): Promise<string | null> {
  if (API_ID_RE.test(ref) && !/\d{6,}/.test(ref)) return ref;
  const numeric = extractNumericSuffix(ref);
  if (numeric) {
    const favorites = await fetchFavorites(session);
    const hit = favorites.find((f) => f.webSlug && f.webSlug.endsWith("-" + numeric));
    if (hit) return hit.id;
  }
  if (!/^\d+$/.test(slugPart(ref))) {
    const page = await scrapePage(`/item/${slugPart(ref)}`).catch(() => null);
    if (page) {
      const raw = firstOf(page.props, ["item", "listing", "product", "itemDetail"]);
      const id = raw && typeof raw === "object" ? (raw as Record<string, unknown>).id : undefined;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return null;
}

const FAVORITE_PATHS: Array<(id: string) => { method: string; path: string; body?: unknown }> = [
  (id) => ({ method: "PUT", path: `/api/v3/items/${id}/favorite`, body: { favorited: true } }),
  (id) => ({ method: "POST", path: `/api/v3/items/${id}/favorite`, body: {} }),
  (id) => ({ method: "POST", path: `/api/v3/items/${id}/favorites`, body: {} }),
];

const UNFAVORITE_PATHS: Array<(id: string) => { method: string; path: string; body?: unknown }> = [
  (id) => ({ method: "PUT", path: `/api/v3/items/${id}/favorite`, body: { favorited: false } }),
  (id) => ({ method: "DELETE", path: `/api/v3/items/${id}/favorite` }),
  (id) => ({ method: "DELETE", path: `/api/v3/items/${id}/favorites` }),
];

export async function favoriteListing(session: SessionManager, ref: string): Promise<boolean> {
  await session.ensureFreshToken();
  const apiId = await resolveApiId(session, ref);
  if (!apiId) {
    throw new WallapopError(
      "Could not resolve the listing API id. For new favorites use the web slug or full item URL (e.g. https://es.wallapop.com/item/<slug>-<id>).",
      "NO_API_ID"
    );
  }
  for (const builder of FAVORITE_PATHS) {
    const { method, path, body } = builder(apiId);
    try {
      const res = await apiRequest({ method, path, body, ...session.authHeaders() });
      if (res.status < 300) return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status && status !== 404 && status !== 400) throw err;
    }
  }
  throw new WallapopError(
    "Could not favorite listing: none of the candidate favorite endpoints worked (reverse-engineered endpoints may have changed).",
    "FAVORITE_ENDPOINT"
  );
}

export async function unfavoriteListing(session: SessionManager, ref: string): Promise<boolean> {
  await session.ensureFreshToken();
  const apiId = await resolveApiId(session, ref);
  if (!apiId) {
    throw new WallapopError(
      "Listing is not in the favorites list (or its API id could not be resolved).",
      "NOT_FAVORITED"
    );
  }
  for (const builder of UNFAVORITE_PATHS) {
    const { method, path, body } = builder(apiId);
    try {
      const res = await apiRequest({ method, path, body, ...session.authHeaders() });
      if (res.status < 300) return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status && status !== 404 && status !== 400) throw err;
    }
  }
  throw new WallapopError(
    "Could not unfavorite listing: none of the candidate endpoints worked (reverse-engineered endpoints may have changed).",
    "UNFAVORITE_ENDPOINT"
  );
}

export { fetchFavorites };