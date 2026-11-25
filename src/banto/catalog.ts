/** 商品の集まりを作る画面のために、Banto の商品とカテゴリーを読む（products:read） */
import type { Deps } from "../deps";
import { BantoError, bantoApi } from "./client";

export interface ProductRef {
  id: string;
  slug: string;
  name: string;
  category_ids: string[];
  published: boolean;
}

export interface CategoryRef {
  id: string;
  name: string;
  parent_id: string | null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function toProduct(x: unknown): ProductRef | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  if (typeof p["id"] !== "string" || !ID_RE.test(p["id"])) return null;
  const cat = (v: unknown) => (v && typeof v === "object" && typeof (v as Record<string, unknown>)["id"] === "string" ? ((v as Record<string, unknown>)["id"] as string) : null);
  const ids = [cat(p["category"]), ...(Array.isArray(p["extra_categories"]) ? p["extra_categories"].map(cat) : [])].filter((v): v is string => !!v);
  return {
    id: p["id"],
    slug: typeof p["slug"] === "string" ? p["slug"].slice(0, 200) : "",
    name: typeof p["name"] === "string" ? p["name"].slice(0, 200) : "",
    category_ids: ids,
    published: p["published"] === true,
  };
}

export async function searchProducts(deps: Deps, token: string, q: string, offset = 0): Promise<{ items: ProductRef[]; total: number }> {
  const params = new URLSearchParams({ limit: "50", offset: String(offset) });
  if (q) params.set("q", q.slice(0, 100));
  const r = await bantoApi<{ items: unknown[]; total: number }>(deps, token, "GET", `/products?${params.toString()}`);
  return { items: (r.items ?? []).map(toProduct).filter((p): p is ProductRef => !!p), total: typeof r.total === "number" ? r.total : 0 };
}

export async function listCategories(deps: Deps, token: string): Promise<CategoryRef[]> {
  const r = await bantoApi<{ categories: unknown[] }>(deps, token, "GET", `/categories`);
  return (r.categories ?? [])
    .map((x) => {
      const c = (x ?? {}) as Record<string, unknown>;
      return typeof c["id"] === "string" && typeof c["name"] === "string"
        ? { id: c["id"], name: c["name"].slice(0, 200), parent_id: typeof c["parent_id"] === "string" ? c["parent_id"] : null }
        : null;
    })
    .filter((c): c is CategoryRef => !!c);
}

/**
 * カテゴリー（下のカテゴリーも含めて渡す）の商品（主カテゴリーか追加カテゴリーのどれか）。Banto の商品の一覧にはカテゴリーの絞り込みが無いので、
 * 新しい順に pages × 100 件まで読んで手代の側で選ぶ（それより古い商品は検索で足す）
 */
/** そのカテゴリーと、その下のカテゴリー（子・孫…）の ID */
export function withDescendants(categories: CategoryRef[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of categories) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

export async function productsInCategory(deps: Deps, token: string, categoryIds: Set<string>, pages = 5): Promise<{ items: ProductRef[]; truncated: boolean }> {
  const out: ProductRef[] = [];
  let total = 0;
  let read = 0;
  for (let i = 0; i < pages; i++) {
    const r = await bantoApi<{ items: unknown[]; total: number }>(deps, token, "GET", `/products?limit=100&offset=${i * 100}`);
    const items = (r.items ?? []).map(toProduct).filter((p): p is ProductRef => !!p);
    total = typeof r.total === "number" ? r.total : 0;
    read += items.length;
    out.push(...items.filter((p) => p.category_ids.some((id) => categoryIds.has(id))));
    if (items.length < 100) break;
  }
  return { items: out, truncated: read < total };
}

export interface ProductSnapshot {
  id: string;
  name: string;
  slug: string;
  published: boolean;
  /** SKU の在庫の合計 */
  available: number;
  /** いちばん安い SKU の値段（SKU が無ければ null） */
  min_price: number | null;
  /** SKU ごとのオプション・在庫・値段 */
  skus: Record<string, { o: Record<string, string>; a: number; p: number | null }>;
  /** ショップのオプションの名前の表（{ color: "カラー" }） */
  option_names: Record<string, string>;
}

/** 商品を 1 つ読む（products:read）。無ければ null */
export async function productSnapshot(deps: Deps, token: string, id: string): Promise<ProductSnapshot | null> {
  let r: Record<string, unknown>;
  try {
    r = await bantoApi<Record<string, unknown>>(deps, token, "GET", `/products/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof BantoError && e.status === 404) return null;
    throw e;
  }
  const skus = Array.isArray(r["skus"]) ? (r["skus"] as Record<string, unknown>[]) : [];
  const prices = skus.map((k) => k["price_jpy"]).filter((p): p is number => typeof p === "number");
  const map: ProductSnapshot["skus"] = {};
  for (const k of skus) {
    if (typeof k["id"] !== "string") continue;
    const o: Record<string, string> = {};
    const raw = k["options"];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [key, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") o[key] = v.slice(0, 100);
    map[k["id"]] = { o, a: typeof k["available"] === "number" ? Math.max(0, k["available"]) : 0, p: typeof k["price_jpy"] === "number" ? k["price_jpy"] : null };
  }
  const names: Record<string, string> = {};
  const rawNames = r["option_names"];
  if (rawNames && typeof rawNames === "object" && !Array.isArray(rawNames))
    for (const [key, v] of Object.entries(rawNames as Record<string, unknown>)) if (typeof v === "string") names[key] = v.slice(0, 40);
  return {
    id,
    name: typeof r["name"] === "string" ? r["name"].slice(0, 200) : "",
    slug: typeof r["slug"] === "string" ? r["slug"].slice(0, 200) : "",
    published: r["published"] === true,
    available: skus.reduce((a, k) => a + (typeof k["available"] === "number" ? Math.max(0, k["available"]) : 0), 0),
    min_price: prices.length > 0 ? Math.min(...prices) : null,
    skus: map,
    option_names: names,
  };
}
