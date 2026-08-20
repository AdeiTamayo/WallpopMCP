import { webFetch } from "../client/httpClient.js";
import { WallapopError } from "../types.js";

const HTML_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

export interface SsrPage {
  props: Record<string, unknown>;
  pageProps: Record<string, unknown>;
  html: string;
  url: string;
}

export function extractNextData(html: string): Record<string, unknown> | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    const props = data.props;
    if (!props || typeof props !== "object") return {};
    const pageProps = (props as Record<string, unknown>).pageProps;
    return pageProps && typeof pageProps === "object" ? (pageProps as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export async function scrapePage(path: string, referer = "https://es.wallapop.com/"): Promise<SsrPage> {
  const res = await webFetch(path, referer, HTML_HEADERS);
  const pageProps = extractNextData(res.text);
  if (!pageProps) {
    throw new WallapopError("SSR page did not contain __NEXT_DATA__", "SSR_PARSE");
  }
  return {
    props: pageProps,
    pageProps,
    html: res.text,
    url: res.url,
  };
}

export function firstOf(pageProps: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const v = pageProps[key];
    if (v !== null && v !== undefined && typeof v === "object") {
      if (Array.isArray(v)) {
        if (v.length > 0 && typeof v[0] === "object" && v[0] !== null) return v[0] as Record<string, unknown>;
        continue;
      }
      return v as Record<string, unknown>;
    }
  }
  return null;
}

export function extractJsonLd(html: string): Record<string, unknown> | null {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}