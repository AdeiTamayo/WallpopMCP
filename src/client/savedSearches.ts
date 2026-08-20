import { apiRequest } from "./httpClient.js";
import { config } from "../config.js";
import type { SessionManager } from "./auth.js";

export interface SavedSearch {
  id: string;
  keywords?: string;
  categoryId?: number;
  orderBy?: string;
  minPrice?: number;
  maxPrice?: number;
  createdAt?: number;
  active?: boolean;
  raw: Record<string, unknown>;
}

export interface SavedSearchParams {
  keywords: string;
  categoryId?: number;
  minPrice?: number;
  maxPrice?: number;
  orderBy?: string;
}

function toSavedSearch(raw: Record<string, unknown>): SavedSearch {
  const q = raw.query as Record<string, unknown> | undefined;
  const alert = raw.alert as Record<string, unknown> | undefined;
  return {
    id: String(raw.id ?? raw.saved_search_id ?? q?.saved_search_id ?? ""),
    keywords:
      typeof q?.keywords === "string"
        ? q.keywords
        : typeof raw.keywords === "string"
          ? raw.keywords
          : undefined,
    categoryId: typeof q?.category_id === "number" ? q.category_id : undefined,
    orderBy: typeof q?.order_by === "string" ? q.order_by : undefined,
    minPrice: typeof q?.min_sale_price === "number" ? q.min_sale_price : undefined,
    maxPrice: typeof q?.max_sale_price === "number" ? q.max_sale_price : undefined,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
    active: alert?.enabled === true || raw.active === true,
    raw,
  };
}

export async function getSavedSearches(session: SessionManager): Promise<SavedSearch[]> {
  await session.ensureFreshToken();
  const res = await apiRequest({
    path: "/api/v3/searchalerts/savedsearch/",
    ...session.authHeaders(),
  });
  const payload = res.json as Record<string, unknown> | null;
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? (payload?.data as unknown[])
      : Array.isArray(payload?.saved_searches)
        ? (payload.saved_searches as unknown[])
        : [];
  return arr
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map(toSavedSearch);
}

export async function createSavedSearch(session: SessionManager, params: SavedSearchParams): Promise<SavedSearch> {
  await session.ensureFreshToken();
  const query: Record<string, string | number> = { keywords: params.keywords };
  if (params.categoryId !== undefined) query.category_id = params.categoryId;
  if (params.minPrice !== undefined) query.min_sale_price = params.minPrice;
  if (params.maxPrice !== undefined) query.max_sale_price = params.maxPrice;
  if (params.orderBy) query.order_by = params.orderBy;
  query.latitude = config.defaultLat;
  query.longitude = config.defaultLng;
  const res = await apiRequest({
    method: "POST",
    path: "/api/v3/searchalerts/savedsearch",
    query,
    ...session.authHeaders(),
  });
  const payload = res.json as Record<string, unknown> | null;
  const data = ((payload?.data ?? payload) as Record<string, unknown> | null) ?? {};
  return toSavedSearch(data);
}

export async function deleteSavedSearch(session: SessionManager, id: string): Promise<boolean> {
  await session.ensureFreshToken();
  const res = await apiRequest({
    method: "DELETE",
    path: `/api/v3/searchalerts/savedsearch/${id}`,
    ...session.authHeaders(),
  });
  return res.status < 300;
}

export async function checkSavedSearchExists(session: SessionManager, params: SavedSearchParams): Promise<boolean> {
  await session.ensureFreshToken();
  const res = await apiRequest({
    path: "/api/v3/searchalerts/savedsearch/exists",
    query: {
      keywords: params.keywords,
      category_id: params.categoryId,
      order_by: params.orderBy,
    },
    ...session.authHeaders(),
  });
  return res.status < 300;
}