import { config } from "../config.js";
import { WallapopBlockedError, WallapopApiError, WallapopAuthError } from "../types.js";
import { generateXSignature, currentTimestampMillis } from "./signature.js";

export const API_BASE = "https://api.wallapop.com";
export const WEB_BASE = "https://es.wallapop.com";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

export interface ApiRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  baseUrl?: string;
  referer?: string;
  bearerToken?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  followRedirects?: boolean;
}

export interface ApiResponse {
  status: number;
  json: unknown | null;
  text: string;
  headers: Headers;
  url: string;
}

let lastRequestAt = 0;
let uaIndex = 0;

function pickUserAgent(): string {
  return USER_AGENTS[uaIndex++ % USER_AGENTS.length];
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + config.rateDelayMs - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

function buildHeaders(opts: ApiRequestOptions, userAgent: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "User-Agent": userAgent,
    "X-DeviceOS": "0",
    "X-AppVersion": "825980",
    Origin: "https://es.wallapop.com",
    Referer: opts.referer ?? "https://es.wallapop.com/",
  };
  if (opts.bearerToken) {
    headers["Authorization"] = "Bearer " + opts.bearerToken;
  }
  if (opts.cookies) {
    headers["Cookie"] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function doFetch(
  fullUrl: string,
  opts: ApiRequestOptions,
  userAgent: string,
  signature: string | null
): Promise<ApiResponse> {
  await throttle();
  const headers = buildHeaders(opts, userAgent);
  if (opts.headers) {
    Object.assign(headers, opts.headers);
  }
  if (signature) {
    headers["X-Signature"] = signature;
    headers["Timestamp"] = currentTimestampMillis();
  }
  const res = await fetch(fullUrl, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: opts.followRedirects ? "follow" : "manual",
  });
  const text = await res.text();
  let json: unknown | null = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers, url: fullUrl };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function looksLikeBlockPage(text: string): boolean {
  const head = text.slice(0, 3000).toLowerCase();
  return head.includes("captcha") || head.includes("access denied") || head.includes("cf-chl-");
}

export async function apiRequest(opts: ApiRequestOptions): Promise<ApiResponse> {
  const method = opts.method ?? "GET";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const q = qs.toString();
  const pathWithQuery = opts.path + (q ? "?" + q : "");
  const baseUrl = opts.baseUrl ?? API_BASE;
  const fullUrl = baseUrl + pathWithQuery;
  const signatureStages: Array<{ form: "path" | "full" } | null> = [null, { form: "path" }, { form: "full" }];
  for (let i = 0; i < signatureStages.length; i++) {
    const stage = signatureStages[i];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const userAgent = pickUserAgent();
      const signature =
        stage === null ? null : generateXSignature(fullUrl, method, currentTimestampMillis(), stage.form);
      let res: ApiResponse;
      try {
        res = await doFetch(fullUrl, opts, userAgent, signature);
      } catch (err) {
        lastError = err;
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 200 && res.json === null && looksLikeBlockPage(res.text)) {
        throw new WallapopBlockedError("Wallapop returned a block/captcha page although status was 200");
      }
      if (res.status === 429) {
        lastError = new WallapopApiError("Rate limited by Wallapop (429)", 429);
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 403 || res.status === 451) {
        lastError = new WallapopBlockedError(`Wallapop blocked the request (${res.status})`);
        break;
      }
      if (res.status === 401) {
        throw new WallapopAuthError("Authentication failed (401) - token expired or invalid");
      }
      if (res.status >= 500) {
        lastError = new WallapopApiError(`Wallapop API error ${res.status}`, res.status);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status >= 400) {
        throw new WallapopApiError(`Wallapop API error ${res.status}: ${res.text.slice(0, 300)}`, res.status);
      }
      return res;
    }
    if (lastError instanceof WallapopBlockedError) {
      if (i < signatureStages.length - 1) {
        await sleep(1200 * (i + 1));
        continue;
      }
      throw lastError;
    }
    throw new WallapopApiError(
      "Request failed: " + (lastError instanceof Error ? lastError.message : String(lastError)),
      0
    );
  }
  throw new WallapopApiError("Exhausted retries", 0);
}

export async function webFetch(
  path: string,
  referer = "https://es.wallapop.com/",
  headers?: Record<string, string>
): Promise<ApiResponse> {
  return apiRequest({ path, referer, followRedirects: true, headers, baseUrl: WEB_BASE });
}