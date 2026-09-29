import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hybrid, memoize } from "../hybrid.js";
import { SessionManager } from "../client/auth.js";
import { config, hasSessionFile } from "../config.js";
import { getSavedSearches, createSavedSearch, deleteSavedSearch } from "../client/savedSearches.js";
import { favoriteListing, unfavoriteListing, resolveApiId } from "../client/favorites.js";
import { getConversations, getConversationMessages, sendMessage, makeOffer, evaluateOfferTarget } from "../client/chat.js";
import { getListingById } from "../client/items.js";
import { browserClient } from "../fallback/browserClient.js";
import { WallapopError } from "../types.js";
import type { ItemSummary } from "../types.js";

const ORDER_BY = ["most_relevance", "newest", "price_low_to_high", "price_high_to_low"] as const;

const BAD_WORDS_SCAN =
  /para piezas|piezas|no funciona|no enciende|face id|reparaci|bloquead|iclo|icloud activ|funda|case|averi|pantalla rota|cristal roto|solo pantalla|reacondicion|clon|r\u00e9plica|replica/i;

const BOOK_SLUG_SCAN = /libro|quimica|invisible|stephen|andrea|tome|vicens|vives|boligrafo|cd-?rom|pelicula|dvd|consola|reloj/i;

const A_READ_LOCAL: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const A_READ_REMOTE: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const A_REFRESH: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const A_CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const A_DELETE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const A_TOGGLE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function textResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof WallapopError ? err.code : "UNKNOWN";
  return {
    content: [{ type: "text", text: `[${code}] ${message}` }],
    isError: true,
  };
}

async function resolveItemUrl(ref: string): Promise<string> {
  if (/^https?:\/\//.test(ref)) return ref;
  if (!/^\d+$/.test(ref)) return `https://es.wallapop.com/item/${ref}`;
  const listing = await hybrid.listing(ref);
  return listing.data.url ?? `https://es.wallapop.com/item/${ref}`;
}

export function registerPublicTools(server: McpServer): void {
  server.registerTool(
    "server_status",
    {
      title: "Get MCP server health and auth status",
      annotations: A_READ_LOCAL,
      description:
        "Returns whether the server is configured for public or authenticated use, whether a session is loaded, and whether browser fallback is available.",
      inputSchema: {},
    },
    async () => {
      try {
        const hasSession = hasSessionFile();
        const sessionState = {
          authenticated: Boolean(config.email || config.password || hasSession),
          sessionFile: config.sessionFile,
          browserFallback: browserClient.isEnabled(),
          defaultLocation: {
            latitude: config.defaultLat,
            longitude: config.defaultLng,
            distanceKm: config.defaultDistanceKm,
          },
          rateLimitMs: config.rateDelayMs,
          maxResultsCap: config.maxResultsCap,
        };
        return textResult({ status: "ok", server: { name: "wallapop-mcp", version: "0.1.0" }, session: sessionState });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_products",
    {
      title: "Search Wallapop listings",
      annotations: A_READ_REMOTE,
      description:
        "Search Wallapop for products with optional filters: category, price range, location (latitude/longitude), radius, sort order. Paginate with the nextPage cursor returned. Reserved listings are filtered out. Returns up to maxResults listings (default 40, capped at 200).",
      inputSchema: {
        keywords: z.string().describe("Search keywords, e.g. 'iphone 15 pro'"),
        categoryId: z.number().int().optional().describe("Restrict to a category, see list_categories"),
        minPrice: z.number().optional().describe("Minimum price in EUR"),
        maxPrice: z.number().optional().describe("Maximum price in EUR"),
        latitude: z.number().optional().describe("Search origin latitude (defaults to Barcelona center)"),
        longitude: z.number().optional().describe("Search origin longitude (defaults to Barcelona center)"),
        distanceKm: z.number().optional().describe("Search radius in km"),
        orderBy: z.enum(ORDER_BY).optional().describe("Sort order"),
        nextPage: z.string().optional().describe("Opaque pagination cursor from a previous search call"),
        maxResults: z.number().int().min(1).max(200).optional().describe("Max results to return (default 40, capped 200)"),
      },
    },
    async (args) => {
      try {
        const result = await hybrid.search({
          keywords: args.keywords,
          categoryId: args.categoryId,
          minPrice: args.minPrice,
          maxPrice: args.maxPrice,
          latitude: args.latitude ?? config.defaultLat,
          longitude: args.longitude ?? config.defaultLng,
          distanceKm: args.distanceKm ?? config.defaultDistanceKm,
          orderBy: args.orderBy,
          nextPage: args.nextPage,
          maxResults: args.maxResults,
        });
        return textResult({ source: result.source, total: result.data.total, listings: result.data.items, nextPage: result.data.nextPage });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get full listing details",
      annotations: A_READ_REMOTE,
      description:
        "Get detailed information about a single Wallapop listing: description, condition, price, images, location, views, favorites, seller id, shipping options. Accepts the numeric listing id, a web slug, or a full item URL. Falls back to server-side rendering when the API fails.",
      inputSchema: {
        itemId: z.string().describe("Listing id (numeric string), web slug, or full item URL"),
      },
    },
    async (args) => {
      try {
        const result = await hybrid.listing(args.itemId);
        return textResult({ source: result.source, listing: result.data });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_seller",
    {
      title: "Get seller information",
      annotations: A_READ_REMOTE,
      description:
        "Get a Wallapop seller profile by numeric user id (from a listing) or by web slug (e.g. 'sergiof-462579195'): rating, review count, sold/published counts, registration date, location.",
      inputSchema: {
        reference: z.string().describe("Seller numeric id or web slug"),
      },
    },
    async (args) => {
      try {
        const result = await hybrid.seller(args.reference);
        return textResult({ source: result.source, seller: result.data });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_categories",
    {
      title: "List Wallapop categories",
      annotations: A_READ_REMOTE,
      description: "List all marketplace top-level categories with ids and subcategories.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await hybrid.categories();
        return textResult({ source: result.source, categories: result.data });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "scan_products",
    {
      title: "Scan multiple searches for phone candidates",
      annotations: A_READ_REMOTE,
      description:
        "Runs several keyword searches (default nationwide radius) and dedupes results, keeping only in-range, shippable listings and flagging suspicious ones (scam wording or book-slug retitled listings). Returns compact candidate list, ready for get_listing/verify.",
      inputSchema: {
        queries: z
          .array(
            z.object({
              keywords: z.string().describe("Search keywords"),
              minPrice: z.number().optional().describe("Keep only listings >= this price"),
              maxPrice: z.number().optional().describe("Keep only listings <= this price"),
            })
          )
          .describe("Keyword/price-range combos to scan (deduped across queries)"),
        distanceKm: z.number().optional().describe("Search radius in km (default 1500 = all Spain)"),
        maxResultsPerQuery: z.number().int().min(1).max(200).optional().describe("Max results per query (default 200)"),
      },
    },
    async (args) => {
      try {
        const distanceKm = args.distanceKm ?? 1500;
        const perQuery = args.maxResultsPerQuery ?? 200;
        const all = new Map<string, ItemSummary>();
        const perQueryStats: Array<{ keywords: string; raw: number; source: string }> = [];
        const cachedSearch = memoize(
          async (query: Parameters<typeof hybrid.search>[0]) => hybrid.search(query),
          { ttlMs: 1500 }
        );

        const results = await Promise.all(
          args.queries.map(async (q) => {
            const min = q.minPrice;
            const max = q.maxPrice;
            const searchArgs = {
              keywords: q.keywords,
              minPrice: min !== undefined ? min - 15 : undefined,
              maxPrice: max !== undefined ? max + 15 : undefined,
              maxResults: perQuery,
              distanceKm,
            };
            const result = await cachedSearch(searchArgs);
            return { q, result, min, max };
          })
        );

        for (const { q, result, min, max } of results) {
          for (const item of result.data.items) {
            const price = typeof item.price === "number" ? (item.price as number) : Number(item.price ?? 0);
            if (min !== undefined && price < min) continue;
            if (max !== undefined && price > max) continue;
            const shipping = item.shipping;
            if (!(shipping?.itemIsShippable && shipping.userAllowsShipping)) continue;
            const id = String(item.id ?? "");
            if (!all.has(id)) all.set(id, item);
          }
          perQueryStats.push({ keywords: q.keywords, raw: result.data.items.length, source: result.source });
        }

        const candidates = [...all.values()].map((item) => {
          const title = String(item.title ?? "");
          const url = String(item.url ?? "");
          const slug = url.replace(/^https?:\/\/[^/]+\/item\//, "").split("?")[0];
          const flagged = BAD_WORDS_SCAN.test(`${title} ${slug}`) || (BOOK_SLUG_SCAN.test(slug) && /iphone|samsung|pixel|galaxy|oneplus|xiaomi|realme/i.test(title));
          return {
            id: String(item.id ?? ""),
            price: typeof item.price === "number" ? item.price : Number(item.price ?? 0),
            title,
            city: (item.city as string | null) ?? null,
            url,
            flagged,
          };
        });
        candidates.sort((a, b) => a.price - b.price);

        return textResult({
          queries: perQueryStats,
          total: candidates.length,
          flaggedCount: candidates.filter((c) => c.flagged).length,
          candidates,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

export function registerAuthTools(server: McpServer, session: SessionManager): void {
  server.registerTool(
    "refresh_session",
    {
      title: "Refresh the Wallapop auth session",
      annotations: A_REFRESH,
      description:
        "Refresh or re-login the current session so favorite and saved-search tools continue to work with fresh access tokens.",
      inputSchema: {},
    },
    async () => {
      try {
        await session.ensureFreshToken();
        const auth = session.getSession();
        return textResult({ refreshed: true, authenticated: session.isAuthenticated(), hasAccessToken: Boolean(auth.accessToken), cookieCount: Object.keys(auth.cookies).length });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_saved_searches",
    {
      title: "List saved searches",
      annotations: A_READ_REMOTE,
      description: "List the saved search alerts of the authenticated Wallapop account.",
      inputSchema: {},
    },
    async () => {
      try {
        const saved = await getSavedSearches(session);
        return textResult({ savedSearches: saved });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_saved_search",
    {
      title: "Save a search",
      annotations: A_CREATE,
      description: "Save a search as an alert on the authenticated account (keywords, category, price range, sort).",
      inputSchema: {
        keywords: z.string().describe("Search keywords"),
        categoryId: z.number().int().optional(),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        orderBy: z.enum(ORDER_BY).optional(),
      },
    },
    async (args) => {
      try {
        const saved = await createSavedSearch(session, {
          keywords: args.keywords,
          categoryId: args.categoryId,
          minPrice: args.minPrice,
          maxPrice: args.maxPrice,
          orderBy: args.orderBy,
        });
        return textResult({ savedSearch: saved });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "delete_saved_search",
    {
      title: "Delete a saved search",
      annotations: A_DELETE,
      description: "Delete a saved search alert by id.",
      inputSchema: {
        searchId: z.string().describe("Saved search id"),
      },
    },
    async (args) => {
      try {
        await deleteSavedSearch(session, args.searchId);
        return textResult({ deleted: true, searchId: args.searchId });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "favorite_listing",
    {
      title: "Favorite a listing",
      annotations: A_TOGGLE,
      description:
        "Add a listing to the authenticated account favorites. Accepts numeric id, web slug, or full item URL. Tries the API first and falls back to browser automation (Persistent Chrome/Edge profile) when the API does not work.",
      inputSchema: {
        itemId: z.string().describe("Listing id (numeric string), web slug, or full item URL"),
      },
    },
    async (args) => {
      try {
        try {
          await favoriteListing(session, args.itemId);
          return textResult({ favorited: true, itemId: args.itemId, source: "api" });
        } catch (err) {
          if (!browserClient.isEnabled()) throw err;
          const url = await resolveItemUrl(args.itemId);
          const res = await browserClient.favorite(url, true);
          return textResult({
            favorited: res.state === "done" || res.state === "already",
            itemId: args.itemId,
            source: "browser",
            state: res.state,
          });
        }
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "unfavorite_listing",
    {
      title: "Unfavorite a listing",
      annotations: A_TOGGLE,
      description:
        "Remove a listing from the authenticated account favorites. Accepts numeric id, web slug, or full item URL. Tries the API first and falls back to browser automation when the API does not work.",
      inputSchema: {
        itemId: z.string().describe("Listing id (numeric string), web slug, or full item URL"),
      },
    },
    async (args) => {
      try {
        try {
          await unfavoriteListing(session, args.itemId);
          return textResult({ unfavorited: true, itemId: args.itemId, source: "api" });
        } catch (err) {
          if (!browserClient.isEnabled()) throw err;
          const res = await browserClient.removeFromFavoritesGrid(args.itemId);
          if (res.state === "done" || res.state === "already") {
            return textResult({
              unfavorited: true,
              itemId: args.itemId,
              source: "browser",
              state: res.state,
            });
          }
          const url = await resolveItemUrl(args.itemId);
          const heart = await browserClient.favorite(url, false);
          return textResult({
            unfavorited: heart.state === "done" || heart.state === "already",
            itemId: args.itemId,
            source: "browser",
            state: heart.state,
          });
        }
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List chat conversations",
      annotations: A_READ_REMOTE,
      description:
        "List the chat conversations of the authenticated account: the other user, the item being discussed, unread count, and the last message of each conversation. Auth required.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await getConversations(session);
        return textResult({
          userHash: result.userHash,
          unread: result.unread,
          conversations: result.conversations.map((c) => ({
            hash: c.hash,
            withUser: c.withUser,
            item: c.item,
            unread: c.unread,
            lastMessage: c.messages.length > 0 ? c.messages[0] : null,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get messages of a conversation",
      annotations: A_READ_REMOTE,
      description:
        "Get the full message history of a single chat conversation (up to the last 30 messages bundled in the inbox). Auth required.",
      inputSchema: {
        conversationId: z.string().describe("Conversation hash (see list_conversations)"),
      },
    },
    async (args) => {
      try {
        const conv = await getConversationMessages(session, args.conversationId);
        if (!conv) {
          return textResult({ conversation: null, message: `Conversation not found: ${args.conversationId}` });
        }
        return textResult({
          conversation: {
            hash: conv.hash,
            withUser: conv.withUser,
            item: conv.item,
            unread: conv.unread,
            channel: conv.channel,
            topicId: conv.topicId,
          },
          messages: conv.messages,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a chat message",
      annotations: A_CREATE,
      description:
        "Send a text message in an existing chat conversation (see list_conversations for the conversation id). Publishes via the Wallapop chat channel. Auth required.",
      inputSchema: {
        conversationId: z.string().describe("Conversation hash (see list_conversations)"),
        text: z.string().describe("Message text to send"),
      },
    },
    async (args) => {
      try {
        await sendMessage(session, args.conversationId, args.text);
        return textResult({ sent: true, conversationId: args.conversationId, text: args.text });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "make_offer",
    {
      title: "Make a purchase offer",
      annotations: A_CREATE,
      description:
        "Send a purchase offer (price in EUR) for an item. The seller receives the offer in the chat and can accept or reject it. Auth required.",
      inputSchema: {
        itemId: z.string().describe("Item id (web slug or hash, e.g. from scan_products results)"),
        amount: z.number().positive().describe("Offer price in EUR"),
      },
    },
    async (args) => {
      try {
        const itemHash = await resolveApiId(session, args.itemId);
        if (!itemHash) {
          throw new WallapopError(
            "Could not resolve the item API hash. Use the web slug or full item URL (e.g. https://es.wallapop.com/item/<slug>-<id>).",
            "NO_API_ID"
          );
        }
        const listing = await getListingById(itemHash);
        const evaluation = evaluateOfferTarget(args.amount, {
          shippable: listing.shipping?.userAllowsShipping,
          itemLat: listing.location?.latitude,
          itemLng: listing.location?.longitude,
          pickupLat: config.pickupLat,
          pickupLng: config.pickupLng,
          pickupRadiusKm: config.pickupRadiusKm,
          protectionPct: config.protectionPct,
          shippingFeeEur: config.shippingFeeEur,
        });
        if (!evaluation.ok) {
          return errorResult(new WallapopError(evaluation.reason ?? "Offer not allowed", "OFFER_UNREACHABLE"));
        }
        const result = await makeOffer(session, itemHash, args.amount);
        return textResult({
          sent: true,
          offerId: result.offerId,
          itemId: itemHash,
          amount: result.amount,
          currency: result.currency,
          shipping: listing.shipping,
          pickupDistanceKm: evaluation.pickupDistanceKm,
          estimatedTotal: evaluation.estimatedTotal,
          breakdown: evaluation.breakdown,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}