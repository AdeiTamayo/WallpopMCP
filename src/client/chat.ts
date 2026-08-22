import { apiRequest } from "./httpClient.js";
import { WallapopError } from "../types.js";
import type { SessionManager } from "./auth.js";
import { randomUUID } from "node:crypto";

const PUBNUB_PUB_KEY = "pub-c-255dc549-86f5-4abd-8b9e-921d5a02fde7";
const PUBNUB_SUB_KEY = "sub-c-89405e27-d4df-4d87-aca1-d6e9118f0a0d";
const PUBNUB_ORIGIN = "https://ps2.pndsn.com";

export interface ChatUser {
  hash: string;
  name: string;
  slug?: string;
  score?: number;
  ratingAverage?: number;
  reviewsCount?: number;
  location?: { latitude?: number; longitude?: number };
}

export interface ChatItem {
  hash: string;
  title: string;
  slug?: string;
  price?: number;
  status?: string;
  imageUrl?: string;
}

export interface ChatMessage {
  id: string;
  fromSelf: boolean;
  text: string;
  timestamp: number;
  status?: string;
  type?: string;
  timeToken?: string;
  payload?: string | null;
}

export interface Conversation {
  hash: string;
  withUser: ChatUser;
  item?: ChatItem | null;
  messages: ChatMessage[];
  unread: number;
  channel: string;
  topicId?: string;
  sale?: { sellerHash?: string; buyerHash?: string };
}

interface InboxResponse {
  user_hash: string;
  unread_messages: number;
  conversations: Array<Record<string, unknown>>;
}

interface PnTokenResponse {
  token: string;
  channels: string[];
}

function convFromRaw(raw: Record<string, unknown>): Conversation {
  const withUserRaw = (raw.with_user ?? {}) as Record<string, unknown>;
  const itemRaw = (raw.item ?? null) as Record<string, unknown> | null;
  const msgsRaw = ((raw.messages as Record<string, unknown> | null)?.messages ?? []) as Array<Record<string, unknown>>;
  const saleRaw = (raw.sale ?? null) as Record<string, unknown> | null;
  const sellerRaw = (saleRaw?.seller ?? null) as Record<string, unknown> | null;
  const buyerRaw = (saleRaw?.buyer ?? null) as Record<string, unknown> | null;
  const locRaw = (withUserRaw.location ?? null) as Record<string, unknown> | null;
  return {
    hash: String(raw.hash ?? ""),
    withUser: {
      hash: String(withUserRaw.hash ?? ""),
      name: String(withUserRaw.name ?? ""),
      slug: typeof withUserRaw.slug === "string" ? withUserRaw.slug : undefined,
      score: typeof withUserRaw.score === "number" ? withUserRaw.score : undefined,
      ratingAverage: typeof withUserRaw.rating_average === "number" ? withUserRaw.rating_average : undefined,
      reviewsCount: typeof withUserRaw.reviews_count === "number" ? withUserRaw.reviews_count : undefined,
      location:
        locRaw && typeof locRaw.latitude === "number"
          ? { latitude: locRaw.latitude, longitude: typeof locRaw.longitude === "number" ? locRaw.longitude : undefined }
          : undefined,
    },
    item: itemRaw
      ? {
          hash: String(itemRaw.hash ?? ""),
          title: String(itemRaw.title ?? ""),
          slug: typeof itemRaw.slug === "string" ? itemRaw.slug : undefined,
          price:
            typeof itemRaw.price === "number"
              ? itemRaw.price
              : typeof ((itemRaw.price as Record<string, unknown> | null)?.amount) === "number"
                ? ((itemRaw.price as Record<string, unknown>).amount as number)
                : undefined,
          status: typeof itemRaw.status === "string" ? itemRaw.status : undefined,
          imageUrl: typeof itemRaw.image_url === "string" ? itemRaw.image_url : undefined,
        }
      : null,
    messages: msgsRaw.map((m) => ({
      id: String(m.id ?? ""),
      fromSelf: Boolean(m.from_self),
      text: String(m.text ?? ""),
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Number(m.timestamp ?? 0),
      status: typeof m.status === "string" ? m.status : undefined,
      type: typeof m.type === "string" ? m.type : undefined,
      timeToken: typeof m.time_token === "string" ? m.time_token : undefined,
      payload: typeof m.payload === "string" ? m.payload : null,
    })),
    unread: typeof raw.unread_messages === "number" ? raw.unread_messages : Number(raw.unread_messages ?? 0),
    channel: String(raw.channel ?? ""),
    topicId: typeof raw.topic_id === "string" ? raw.topic_id : undefined,
    sale: {
      sellerHash: sellerRaw ? String(sellerRaw.hash ?? "") : undefined,
      buyerHash: buyerRaw ? String(buyerRaw.hash ?? "") : undefined,
    },
  };
}

async function getInbox(session: SessionManager): Promise<InboxResponse> {
  const res = await apiRequest({
    path: "/bff/messaging/inbox",
    query: { page_size: 30, max_messages: 30, t: Date.now() },
    ...session.authHeaders(),
  });
  return res.json as InboxResponse;
}

async function getPnToken(session: SessionManager): Promise<PnTokenResponse> {
  const res = await apiRequest({
    path: "/api/v3/instant-messaging/token",
    ...session.authHeaders(),
  });
  const body = res.json as PnTokenResponse | null;
  if (!body || typeof body.token !== "string" || body.token.length === 0) {
    throw new WallapopError("PubNub messaging token response missing 'token'", "PN_TOKEN");
  }
  return body;
}

export async function getConversations(session: SessionManager): Promise<{
  userHash: string;
  unread: number;
  conversations: Conversation[];
}> {
  await session.ensureFreshToken();
  const inbox = await getInbox(session);
  return {
    userHash: inbox.user_hash,
    unread: inbox.unread_messages,
    conversations: (inbox.conversations ?? []).map(convFromRaw),
  };
}

export async function getConversationMessages(session: SessionManager, conversationHash: string): Promise<Conversation | null> {
  await session.ensureFreshToken();
  const inbox = await getInbox(session);
  const raw = (inbox.conversations ?? []).find((c) => String(c.hash) === conversationHash);
  return raw ? convFromRaw(raw) : null;
}

export async function sendMessage(session: SessionManager, conversationHash: string, text: string): Promise<boolean> {
  await session.ensureFreshToken();
  const inbox = await getInbox(session);
  const conv = (inbox.conversations ?? []).find((c) => String(c.hash) === conversationHash);
  if (!conv) {
    throw new WallapopError(`Conversation not found: ${conversationHash}`, "CONV_NOT_FOUND");
  }
  const channel = String(conv.channel ?? "");
  if (!channel) {
    throw new WallapopError("Conversation has no PubNub channel", "CONV_NO_CHANNEL");
  }
  const toUserHash = String(((conv.with_user as Record<string, unknown> | null)?.hash ?? ""));
  const fromUserHash = inbox.user_hash;
  const pn = await getPnToken(session);
  await publishMessage(pn.token, channel, fromUserHash, toUserHash, conversationHash, text);
  return true;
}

export interface OfferResult {
  offerId: string;
  itemIds: string[];
  amount: number;
  currency: string;
}

export interface OfferEvaluation {
  ok: boolean;
  reason?: string;
  shippable: boolean;
  pickupDistanceKm?: number;
  pickupOk: boolean;
  estimatedTotal: number;
  breakdown: {
    offer: number;
    protection: number;
    shipping: number;
    total: number;
  };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function evaluateOfferTarget(
  amount: number,
  opts: {
    shippable?: boolean;
    itemLat?: number;
    itemLng?: number;
    pickupLat?: number;
    pickupLng?: number;
    pickupRadiusKm?: number;
    protectionPct?: number;
    shippingFeeEur?: number;
  }
): OfferEvaluation {
  const protectionPct = opts.protectionPct ?? 8;
  const shippingFee = opts.shippingFeeEur ?? 3;
  const shippable = opts.shippable === true;
  let pickupDistanceKm: number | undefined;
  if (
    opts.itemLat !== undefined &&
    opts.itemLng !== undefined &&
    opts.pickupLat !== undefined &&
    opts.pickupLng !== undefined
  ) {
    pickupDistanceKm = haversineKm(opts.itemLat, opts.itemLng, opts.pickupLat, opts.pickupLng);
  }
  const pickupOk =
    pickupDistanceKm !== undefined &&
    opts.pickupRadiusKm !== undefined &&
    pickupDistanceKm <= opts.pickupRadiusKm;
  const usesShipping = shippable && !pickupOk;
  const protection = usesShipping ? Math.round(amount * (protectionPct / 100) * 100) / 100 : 0;
  const shipping = usesShipping ? shippingFee : 0;
  const total = Math.round((amount + protection + shipping) * 100) / 100;
  let ok = true;
  let reason: string | undefined;
  if (!shippable && !pickupOk) {
    ok = false;
    reason = pickupDistanceKm !== undefined
      ? `Seller only ships by pickup (no Wallapop shipping) and the item is ${Math.round(pickupDistanceKm)} km from your pickup location (radius ${opts.pickupRadiusKm ?? "?"} km).`
      : "Seller only does in-person pickup and no pickup location is configured.";
  }
  return {
    ok,
    reason,
    shippable,
    pickupDistanceKm,
    pickupOk,
    estimatedTotal: total,
    breakdown: { offer: amount, protection, shipping, total },
  };
}

export async function makeOffer(
  session: SessionManager,
  itemHash: string,
  amount: number,
  currency: string = "EUR"
): Promise<OfferResult> {
  await session.ensureFreshToken();
  const offerId = randomUUID();
  const res = await apiRequest({
    path: "/api/v3/delivery/buyer/offers",
    method: "POST",
    body: {
      offer_id: offerId,
      offer_price_amount: amount,
      offer_price_currency: currency,
      item_ids: [itemHash],
    },
    ...session.authHeaders(),
  });
  return { offerId, itemIds: [itemHash], amount, currency };
}

async function publishMessage(
  pnToken: string,
  channel: string,
  fromUserHash: string,
  toUserHash: string,
  conversationHash: string,
  text: string
): Promise<void> {
  const id = randomUUID();
  const payload = JSON.stringify({ id, payload: { text } });
  const meta = JSON.stringify({
    type: "text",
    sender: { platform: { app_version: "8.2616.0", os_version: "0" } },
    to_user_hash: toUserHash,
    from_user_hash: fromUserHash,
    conversation_hash: conversationHash,
  });
  const url =
    `${PUBNUB_ORIGIN}/publish/${PUBNUB_PUB_KEY}/${PUBNUB_SUB_KEY}/0/${channel}/0/` +
    `${encodeURIComponent(payload)}` +
    `?meta=${encodeURIComponent(meta)}` +
    `&uuid=${encodeURIComponent(fromUserHash)}` +
    `&requestid=${randomUUID()}` +
    `&pnsdk=${encodeURIComponent("PubNub-JS-Web/10.2.6")}` +
    `&auth=${encodeURIComponent(pnToken)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "*/*",
      "Accept-Language": "es-ES,es;q=0.9",
      Origin: "https://es.wallapop.com",
      Referer: "https://es.wallapop.com/app/chat",
    },
  });
  const bodyText = await res.text();
  if (res.status !== 200 || !/^\[1,/.test(bodyText.trim())) {
    throw new WallapopError(`PubNub publish failed (${res.status}): ${bodyText.slice(0, 300)}`, "PN_PUBLISH");
  }
}