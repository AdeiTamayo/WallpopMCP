import { apiRequest } from "./httpClient.js";
import type { Category } from "../types.js";

const STATIC_TOP_CATEGORIES: Category[] = [
  { title: "Coches", categoryId: 100 },
  { title: "Motos", categoryId: 14000 },
  { title: "Motor y accesorios", categoryId: 12800 },
  { title: "Moda y accesorios", categoryId: 12465 },
  { title: "Inmobiliaria", categoryId: 200 },
  { title: "Tecnología y electrónica", categoryId: 12545 },
  { title: "Móviles y Telefonía", categoryId: 16000 },
  { title: "Informática", categoryId: 15000 },
  { title: "Deporte y ocio", categoryId: 12579 },
  { title: "Bicicletas", categoryId: 17000 },
  { title: "Consolas y Videojuegos", categoryId: 12900 },
  { title: "Hogar y jardín", categoryId: 12467 },
  { title: "Electrodomésticos", categoryId: 13100 },
  { title: "Cine, libros y música", categoryId: 12463 },
  { title: "Niños y bebés", categoryId: 12461 },
  { title: "Coleccionismo", categoryId: 18000 },
  { title: "Construcción y reformas", categoryId: 19000 },
  { title: "Industria y agricultura", categoryId: 20000 },
  { title: "Empleo", categoryId: 21000 },
  { title: "Servicios", categoryId: 13200 },
];

function normalizeCategory(raw: Record<string, unknown>): Category | null {
  const title = raw.title ?? raw.name ?? raw.label;
  const id = raw.categoryId ?? raw.category_id ?? raw.id ?? raw.value;
  if (typeof title !== "string" || (typeof id !== "number" && typeof id !== "string")) return null;
  const cat: Category = {
    title,
    categoryId: Number(id),
    url: typeof raw.url === "string" ? raw.url : undefined,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
  };
  const subs = raw.subcategories ?? raw.children ?? raw.subcategories_data;
  if (Array.isArray(subs)) {
    const mapped = subs
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
      .map(normalizeCategory)
      .filter((c): c is Category => c !== null);
    if (mapped.length > 0) cat.subcategories = mapped;
  }
  return cat;
}

export async function listCategories(): Promise<Category[]> {
  let payload: unknown;
  try {
    payload = (await apiRequest({ path: "/api/v3/categories" })).json;
  } catch {
    return STATIC_TOP_CATEGORIES;
  }
  const data = (payload as Record<string, unknown> | null)?.data ?? payload;
  const arr = Array.isArray(data) ? data : Array.isArray(getCats(data)) ? getCats(data) : null;
  if (!arr) return STATIC_TOP_CATEGORIES;
  const cats = arr
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map(normalizeCategory)
    .filter((c): c is Category => c !== null);
  return cats.length > 0 ? cats : STATIC_TOP_CATEGORIES;
}

function getCats(obj: unknown): unknown[] {
  if (obj === null || typeof obj !== "object") return [];
  const v = (obj as Record<string, unknown>).categories;
  return Array.isArray(v) ? v : [];
}