export type OrderBy = "most_relevance" | "newest" | "price_low_to_high" | "price_high_to_low";

export interface SearchParams {
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

export interface ItemSummary {
  id: string;
  title: string;
  price: number;
  currency: string;
  imageUrl?: string;
  webSlug?: string;
  city?: string;
  reserved?: boolean;
  favorited?: boolean;
  shipping?: { itemIsShippable?: boolean; userAllowsShipping?: boolean };
  createdAt?: number;
  modifiedAt?: number;
  categoryId?: number;
  sellerId?: string;
  url?: string;
  condition?: string | null;
}

export interface ListingImage {
  id?: string;
  small?: string;
  medium?: string;
  big?: string;
}

export interface ListingDetail extends ItemSummary {
  description?: string;
  images: ListingImage[];
  location?: {
    latitude?: number;
    longitude?: number;
    city?: string;
    postalCode?: string;
    countryCode?: string;
    approximated?: boolean;
  };
  views?: number;
  favorites?: number;
  flags?: {
    reserved?: boolean;
    sold?: boolean;
    bumped?: boolean;
    expired?: boolean;
    onHold?: boolean;
  };
  characteristics?: { attribute?: string; value?: string }[];
  brand?: string | null;
  model?: string | null;
  isRefurbished?: boolean;
  isTopProfile?: boolean;
  shareUrl?: string;
  taxonomies?: { id?: string; name?: string }[];
  delivery?: Record<string, unknown> | null;
}

export interface SellerInfo {
  id: string;
  microName?: string;
  type?: string;
  webSlug?: string;
  featured?: boolean;
  registerDate?: number;
  avatarImage?: string | null;
  location?: {
    city?: string;
    countryCode?: string;
    latitude?: number;
    longitude?: number;
    approximated?: boolean;
  };
  ratings?: { reviews?: number };
  ratingAverage?: number;
  counters?: Record<string, number>;
  badgeType?: string | null;
  isTopProfile?: boolean;
  urlShare?: string;
  publishedItemsCount?: number;
  url?: string;
}

export interface Category {
  title: string;
  categoryId: number;
  url?: string;
  icon?: string;
  subcategories?: Category[];
}

export interface SearchCursor {
  sid: string;
  np: string;
}

export interface SearchOutcome {
  items: ItemSummary[];
  nextPage?: string;
  searchId?: string;
  total?: number;
  source: "api" | "ssr" | "browser";
}

export interface SessionData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  cookies: Record<string, string>;
}

export type Source = "api" | "ssr" | "browser";

export class WallapopError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WallapopError";
  }
}

export class WallapopBlockedError extends WallapopError {
  constructor(message = "Wallapop blocked the request (403 / captcha)") {
    super(message, "BLOCKED");
    this.name = "WallapopBlockedError";
  }
}

export class WallapopAuthError extends WallapopError {
  constructor(message = "Wallapop authentication failed") {
    super(message, "AUTH");
    this.name = "WallapopAuthError";
  }
}

export class WallapopApiError extends WallapopError {
  constructor(message: string, readonly status: number) {
    super(message, "API_" + status);
    this.name = "WallapopApiError";
  }
}

export interface ApiResult<T> {
  data: T;
  source: Source;
}
