import { apiRequest } from "./httpClient.js";
import type { SellerInfo } from "../types.js";

function get(obj: unknown, path: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else cur = (cur as Record<string, unknown>)[key as string];
  }
  return cur;
}

function pickText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object")
    return String(get(v, ["original"]) ?? get(v, ["value"]) ?? "");
  return "";
}

function pickCounters(obj: unknown): Record<string, number> {
  const counters: Record<string, number> = {};
  if (obj === null || typeof obj !== "object") return counters;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number") counters[k] = v;
    else if (typeof v === "object" && v !== null) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "number") counters[k2] = v2;
      }
    }
  }
  return counters;
}

export function normalizeSeller(raw: Record<string, unknown>): SellerInfo {
  const loc = get(raw, ["location"]) as Record<string, unknown> | undefined;
  const avatar = get(raw, ["avatarImage"]) ?? get(raw, ["avatar_image"]) ?? get(raw, ["image"]);
  const avatarUrls =
    avatar && typeof avatar === "object"
      ? ((avatar as Record<string, unknown>).urls_by_size as Record<string, unknown> | undefined) ??
        ((avatar as Record<string, unknown>).urls as Record<string, unknown> | undefined)
      : undefined;
  const stats = get(raw, ["stats"]) as Record<string, unknown> | undefined;
  const userStats = get(raw, ["userStats"]) as Record<string, unknown> | undefined;
  const ratings = get(stats, ["ratings"]) ?? get(userStats, ["ratings"]);
  const counters = {
    ...pickCounters(get(stats, ["counters"])),
    ...pickCounters(get(userStats, ["counters"])),
  };
  const ratingAverage = get(userStats, ["ratingAverage"]);
  const published = get(raw, ["publishedItems"]) as Record<string, unknown> | undefined;
  const webSlug =
    typeof get(raw, ["webSlug"]) === "string"
      ? (get(raw, ["webSlug"]) as string)
      : typeof get(raw, ["web_slug"]) === "string"
        ? (get(raw, ["web_slug"]) as string)
        : undefined;
  return {
    id: String(get(raw, ["id"]) ?? ""),
    microName: pickText(get(raw, ["microName"]) ?? get(raw, ["micro_name"])),
    type: typeof get(raw, ["type"]) === "string" ? (get(raw, ["type"]) as string) : undefined,
    webSlug,
    featured: get(raw, ["featured"]) === true,
    registerDate:
      typeof get(raw, ["registerDate"]) === "number"
        ? (get(raw, ["registerDate"]) as number)
        : typeof get(raw, ["register_date"]) === "number"
          ? (get(raw, ["register_date"]) as number)
          : undefined,
    avatarImage:
      typeof avatar === "string" && avatar.length > 0
        ? avatar
        : avatarUrls
          ? String(avatarUrls.big ?? avatarUrls.medium ?? avatarUrls.small ?? avatarUrls.original ?? "")
          : null,
    location: loc
      ? {
          city: typeof loc.city === "string" ? loc.city : undefined,
          countryCode:
            typeof loc.country_code === "string"
              ? loc.country_code
              : typeof loc.countryCode === "string"
                ? loc.countryCode
                : undefined,
          latitude:
            typeof loc.latitude === "number"
              ? loc.latitude
              : typeof loc.approximated_latitude === "number"
                ? loc.approximated_latitude
                : undefined,
          longitude:
            typeof loc.longitude === "number"
              ? loc.longitude
              : typeof loc.approximated_longitude === "number"
                ? loc.approximated_longitude
                : undefined,
          approximated: loc.approximated === true || loc.approximated_location === true,
        }
      : undefined,
    ratings:
      ratings && typeof get(ratings, ["reviews"]) === "number"
        ? { reviews: get(ratings, ["reviews"]) as number }
        : undefined,
    ratingAverage: typeof ratingAverage === "number" ? ratingAverage : undefined,
    counters: Object.keys(counters).length > 0 ? counters : undefined,
    badgeType:
      typeof get(raw, ["badgeType"]) === "string"
        ? (get(raw, ["badgeType"]) as string)
        : typeof get(raw, ["badge_type"]) === "string"
          ? (get(raw, ["badge_type"]) as string)
          : null,
    isTopProfile: get(raw, ["isTopProfile"]) === true || get(raw, ["is_top_profile"]) === true,
    urlShare:
      typeof get(raw, ["urlShare"]) === "string"
        ? (get(raw, ["urlShare"]) as string)
        : typeof get(raw, ["url_share"]) === "string"
          ? (get(raw, ["url_share"]) as string)
          : typeof get(raw, ["share_url"]) === "string"
            ? (get(raw, ["share_url"]) as string)
            : undefined,
    publishedItemsCount:
      userStats && typeof get(userStats, ["counters", "publish"]) === "number"
        ? (get(userStats, ["counters", "publish"]) as number)
        : published && typeof get(published, ["meta", "total"]) === "number"
          ? (get(published, ["meta", "total"]) as number)
          : undefined,
    url: webSlug ? `https://es.wallapop.com/user/${webSlug}` : undefined,
  };
}

export async function getSellerById(id: string): Promise<SellerInfo> {
  const res = await apiRequest({ path: `/api/v3/users/${id}` });
  const payload = res.json;
  const raw = (get(payload, ["data"]) ?? get(payload, ["user"]) ?? payload) as Record<string, unknown>;
  return normalizeSeller(raw);
}