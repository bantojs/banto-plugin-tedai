/**
 * お気に入りのきっかけの「見る単位」（Banto の SKU のオプションと同じ考え方）。
 * - product: 商品の SKU を全部まとめる
 * - axes: 選んだオプション（例 color）の値が同じ SKU をまとめる（color=red の SKU すべて）
 * - sku: 全部のオプションが同じ = SKU 1 つ
 * 選んだオプションを持たない商品は、持っているオプションだけでまとめる（どれも無ければ商品ごと）。
 */
import type { Trigger } from "./triggers";

export type Variant = Record<string, string>;

export interface SkuState {
  /** オプション（{ color: "red", size: "01" }） */
  o: Variant;
  /** 在庫 */
  a: number;
  /** 値段 */
  p: number | null;
}

export type SkuMap = Record<string, SkuState>;

export interface Group {
  variant: Variant;
  available: number;
  minPrice: number | null;
}

/** その SKU が入るまとまり（商品ごとなら空） */
export function variantOf(options: Variant, t: Pick<Trigger, "unit" | "axes">): Variant {
  if (!t.unit || t.unit === "product") return {};
  const keys = t.unit === "sku" ? Object.keys(options) : (t.axes ?? []).filter((k) => k in options);
  const out: Variant = {};
  for (const k of keys.sort()) out[k] = options[k]!;
  return out;
}

/** まとまりの鍵（"color=red|size=01"、商品ごとは ""） */
export const variantKey = (v: Variant) =>
  Object.keys(v)
    .sort()
    .map((k) => `${k}=${v[k]}`)
    .join("|");

export function groupsOf(skus: SkuMap, t: Pick<Trigger, "unit" | "axes">): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const s of Object.values(skus)) {
    const v = variantOf(s.o, t);
    const key = variantKey(v);
    const g = out.get(key) ?? { variant: v, available: 0, minPrice: null };
    g.available += Math.max(0, s.a);
    if (s.p !== null) g.minPrice = g.minPrice === null ? s.p : Math.min(g.minPrice, s.p);
    out.set(key, g);
  }
  return out;
}

/** そのまとまりに入る SKU の在庫の合計 */
export function availableIn(skus: SkuMap, variant: Variant): number {
  return Object.values(skus)
    .filter((s) => Object.entries(variant).every(([k, v]) => s.o[k] === v))
    .reduce((a, s) => a + Math.max(0, s.a), 0);
}

/** 画面と文に出す形（「カラー: red / サイズ: 01」）。names はショップのオプションの名前の表 */
export function variantLabel(v: Variant | null | undefined, names: Record<string, string> = {}): string {
  if (!v) return "";
  return Object.keys(v)
    .map((k) => `${names[k] ?? k}: ${v[k]}`)
    .join(" / ");
}

export function readVariant(json: string | null | undefined): Variant | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Variant = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
