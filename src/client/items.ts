import { apiRequest } from "./httpClient.js";
import type { ListingDetail, ListingImage, ShippingInfo } from "../types.js";

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

function pickImages(item: Record<string, unknown>): ListingImage[] {
  const imgs = get(item, ["images"]);
  if (!Array.isArray(imgs)) return [];
  return imgs
    .filter((i) => i !== null && typeof i === "object")
    .map((img) => {
      const urls = get(img, ["urls"]) as Record<string, unknown> | undefined;
      const imgObj = img as { id?: unknown };
      return {
        id: typeof imgObj.id === "string" ? imgObj.id : undefined,
        small: urls && typeof urls.small === "string" ? urls.small : undefined,
        medium: urls && typeof urls.medium === "string" ? urls.medium : undefined,
        big: urls && typeof urls.big === "string" ? urls.big : undefined,
      };
    });
}

function pickShipping(raw: Record<string, unknown>): ShippingInfo | undefined {
  const shipping = get(raw, ["shipping"]) as Record<string, unknown> | undefined;
  if (!shipping) return undefined;
  return {
    itemIsShippable:
      shipping.item_is_shippable === true || shipping.isItemShippable === true,
    userAllowsShipping:
      shipping.user_allows_shipping === true || shipping.isShippingAllowedByUser === true,
    costConfigurationId:
      typeof shipping.cost_configuration_id === "string"
        ? shipping.cost_configuration_id
        : typeof shipping.costConfigurationId === "string"
          ? shipping.costConfigurationId
          : undefined,
  };
}

export function normalizeListingDetail(raw: Record<string, unknown>): ListingDetail {
  const priceCash = get(raw, ["price", "cash"]) as Record<string, unknown> | undefined;
  const flags = get(raw, ["flags"]) as Record<string, unknown> | undefined;
  const loc = get(raw, ["location"]) as Record<string, unknown> | undefined;
  const shipping = get(raw, ["shipping"]) as Record<string, unknown> | undefined;
  const webSlug = String(get(raw, ["web_slug"]) ?? get(raw, ["slug"]) ?? get(raw, ["webSlug"]) ?? "");
  const counters = get(raw, ["counters"]) as Record<string, unknown> | undefined;
  const user = get(raw, ["user"]) as Record<string, unknown> | undefined;
  const typeAttrs = get(raw, ["type_attributes"]) as Record<string, unknown> | undefined;
  const conditionAttr = get(typeAttrs, ["condition"]) as Record<string, unknown> | undefined;
  const characteristicsSource =
    get(raw, ["characteristicsDetails"]) ?? get(raw, ["characteristics_details"]) ?? get(raw, ["characteristics"]);
  const taxonomySource = get(raw, ["taxonomies"]) ?? get(raw, ["taxonomy"]);
  const modifiedDate = get(raw, ["modified_date"]) ?? get(raw, ["modifiedAt"]);
  return {
    id: String(get(raw, ["id"]) ?? ""),
    title: pickText(get(raw, ["title"])),
    description: pickText(get(raw, ["description"])),
    price:
      typeof get(priceCash, ["amount"]) === "number"
        ? (get(priceCash, ["amount"]) as number)
        : ((get(raw, ["price", "amount"]) as number | undefined) ?? 0),
    currency:
      typeof get(priceCash, ["currency"]) === "string"
        ? (get(priceCash, ["currency"]) as string)
        : "EUR",
    webSlug: webSlug || undefined,
    url: webSlug ? `https://es.wallapop.com/item/${webSlug}` : undefined,
    images: pickImages(raw),
    location: loc
      ? {
          latitude: typeof loc.latitude === "number" ? loc.latitude : undefined,
          longitude: typeof loc.longitude === "number" ? loc.longitude : undefined,
          city: typeof loc.city === "string" ? loc.city : undefined,
          postalCode:
            typeof loc.postal_code === "string"
              ? loc.postal_code
              : typeof loc.postalCode === "string"
                ? loc.postalCode
                : undefined,
          countryCode:
            typeof loc.country_code === "string"
              ? loc.country_code
              : typeof loc.countryCode === "string"
                ? loc.countryCode
                : undefined,
          approximated: loc.approximated === true || loc.approximated_location === true,
        }
      : undefined,
    views:
      typeof get(counters, ["views"]) === "number"
        ? (get(counters, ["views"]) as number)
        : typeof get(raw, ["views"]) === "number"
          ? (get(raw, ["views"]) as number)
          : undefined,
    favorites:
      typeof get(counters, ["favorites"]) === "number"
        ? (get(counters, ["favorites"]) as number)
        : typeof get(raw, ["favorites"]) === "number"
          ? (get(raw, ["favorites"]) as number)
          : undefined,
    flags: flags
      ? {
          reserved: flags.reserved === true || flags.reserved === "true",
          sold: flags.sold === true || flags.sold === "true",
          bumped: flags.bumped === true || flags.bumped === "true",
          expired: flags.expired === true || flags.expired === "true",
          onHold: flags.onHold === true || flags.on_hold === true,
        }
      : undefined,
    characteristics: Array.isArray(characteristicsSource)
      ? characteristicsSource
          .filter((c) => c !== null && typeof c === "object")
          .map((c) => ({
            attribute: pickText(get(c, ["attribute"])),
            value: pickText(get(c, ["value"])),
          }))
      : undefined,
    brand:
      typeof get(raw, ["brand"]) === "string"
        ? (get(raw, ["brand"]) as string)
        : typeof get(typeAttrs, ["brand", "value"]) === "string" ||
            typeof get(typeAttrs, ["brand", "text"]) === "string"
          ? ((get(typeAttrs, ["brand", "text"]) ?? get(typeAttrs, ["brand", "value"])) as string)
          : null,
    model:
      typeof get(raw, ["model"]) === "string"
        ? (get(raw, ["model"]) as string)
        : typeof get(typeAttrs, ["model", "text"]) === "string" ||
            typeof get(typeAttrs, ["model", "value"]) === "string"
          ? ((get(typeAttrs, ["model", "text"]) ?? get(typeAttrs, ["model", "value"])) as string)
          : null,
    isRefurbished:
      get(raw, ["is_refurbished"]) === true || get(raw, ["isRefurbished"]) === true,
    isTopProfile: get(user, ["is_top_profile"]) === true || get(raw, ["is_top_profile"]) === true,
    shareUrl:
      typeof get(raw, ["shareUrl"]) === "string"
        ? (get(raw, ["shareUrl"]) as string)
        : typeof get(raw, ["share_url"]) === "string"
          ? (get(raw, ["share_url"]) as string)
          : undefined,
    taxonomies: Array.isArray(taxonomySource)
      ? taxonomySource
          .filter((t) => t !== null && typeof t === "object")
          .map((t) => ({ id: String(get(t, ["id"]) ?? ""), name: pickText(get(t, ["name"])) }))
      : undefined,
    delivery: (get(raw, ["delivery"]) as Record<string, unknown> | null | undefined) ?? null,
    shipping: pickShipping(raw),
    sellerId: String(get(user, ["id"]) ?? get(raw, ["user_id"]) ?? get(raw, ["userId"]) ?? ""),
    condition:
      typeof get(raw, ["condition"]) === "string"
        ? (get(raw, ["condition"]) as string)
        : conditionAttr
          ? String(get(conditionAttr, ["text"]) ?? get(conditionAttr, ["value"]) ?? "")
          : null,
    city: loc && typeof loc.city === "string" ? loc.city : undefined,
    createdAt: typeof get(raw, ["created_at"]) === "number" ? (get(raw, ["created_at"]) as number) : undefined,
    modifiedAt: typeof modifiedDate === "number" ? modifiedDate : undefined,
    reserved: get(raw, ["reserved"]) === true || get(raw, ["reserved"]) === "true",
  };
}

export async function getListingById(id: string): Promise<ListingDetail> {
  let payload: unknown;
  try {
    payload = (await apiRequest({ path: `/api/v3/items/${id}` })).json;
  } catch {
    const res = await apiRequest({
      path: "/api/v3/item-detail/components",
      query: { item_id: id },
    });
    payload = res.json;
  }
  const raw = (get(payload, ["data"]) ?? get(payload, ["item"]) ?? payload) as Record<string, unknown>;
  return normalizeListingDetail(raw);
}