import { createHmac } from "node:crypto";

const SIGNATURE_KEY =
  "Tm93IHRoYXQgeW91J3ZlIGZvdW5kIHRoaXMsIGFyZSB5b3UgcmVhZHkgdG8gam9pbiB1cz8gam9ic0B3YWxsYXBvcC5jb20==";

export function generateXSignature(url: string, method: string, timestamp: string, form: "path" | "full" = "path"): string {
  let normalizedUrl: string;
  try {
    const u = new URL(url);
    normalizedUrl = form === "path" ? u.pathname + u.search : url;
  } catch {
    normalizedUrl = url.split("?")[0];
  }
  const payload = [method, normalizedUrl, timestamp].join("|") + "|";
  return createHmac("sha256", SIGNATURE_KEY).update(payload).digest("base64");
}

export function currentTimestampMillis(): string {
  return String(Date.now());
}