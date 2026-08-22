import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

export interface AppConfig {
  email?: string;
  password?: string;
  cookiesFile?: string;
  defaultLat: number;
  defaultLng: number;
  defaultDistanceKm: number;
  sessionFile: string;
  rateDelayMs: number;
  browser: "auto" | "chrome" | "msedge" | "chromium" | "off";
  maxResultsCap: number;
  pickupLat?: number;
  pickupLng?: number;
  pickupRadiusKm?: number;
  protectionPct: number;
  shippingFeeEur: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function loadConfig(): AppConfig {
  const sessionFile = process.env.WALLAPOP_SESSION_FILE ?? path.join(projectRoot, "wallapop-session.json");
  const browser = (process.env.WALLAPOP_BROWSER ?? "auto") as AppConfig["browser"];
  const pickupLat = process.env.WALLAPOP_PICKUP_LAT ? Number(process.env.WALLAPOP_PICKUP_LAT) : undefined;
  const pickupLng = process.env.WALLAPOP_PICKUP_LNG ? Number(process.env.WALLAPOP_PICKUP_LNG) : undefined;
  const pickupRadiusKm = process.env.WALLAPOP_PICKUP_RADIUS_KM ? Number(process.env.WALLAPOP_PICKUP_RADIUS_KM) : undefined;
  return {
    email: process.env.WALLAPOP_EMAIL || undefined,
    password: process.env.WALLAPOP_PASSWORD || undefined,
    cookiesFile: process.env.WALLAPOP_COOKIES_FILE || undefined,
    defaultLat: num("WALLAPOP_DEFAULT_LAT", 41.3829),
    defaultLng: num("WALLAPOP_DEFAULT_LNG", 2.1774),
    defaultDistanceKm: num("WALLAPOP_DEFAULT_DISTANCE_KM", 50),
    sessionFile: path.resolve(sessionFile),
    rateDelayMs: num("WALLAPOP_RATE_DELAY_MS", 600),
    browser: ["auto", "chrome", "msedge", "chromium", "off"].includes(browser) ? browser : "auto",
    maxResultsCap: num("WALLAPOP_MAX_RESULTS", 200),
    pickupLat: pickupLat !== undefined && Number.isFinite(pickupLat) ? pickupLat : undefined,
    pickupLng: pickupLng !== undefined && Number.isFinite(pickupLng) ? pickupLng : undefined,
    pickupRadiusKm: pickupRadiusKm !== undefined && Number.isFinite(pickupRadiusKm) ? pickupRadiusKm : undefined,
    protectionPct: num("WALLAPOP_PROTECTION_PCT", 8),
    shippingFeeEur: num("WALLAPOP_SHIPPING_FEE_EUR", 3),
  };
}

export const config: AppConfig = loadConfig();

export function hasCredentials(): boolean {
  return Boolean(config.email && config.password);
}

export function hasSessionFile(): boolean {
  return fs.existsSync(config.sessionFile);
}
