/** アクションで呼ぶ Banto の口（会員・クーポン・LINE・注文の印）。返すのは使う分だけ */
import type { Deps } from "../deps";
import { bantoApi } from "./client";

export interface CustomerView {
  id: string;
  name: string | null;
  email: string | null;
  marketing_consent: boolean | null;
}

/** 送る直前に読む（customers:read）。名前とアドレスはこの呼び出しの中だけで使い、D1 に置かない */
export async function getCustomer(deps: Deps, token: string, id: string): Promise<CustomerView> {
  const r = await bantoApi<Record<string, unknown>>(deps, token, "GET", `/customers/${encodeURIComponent(id)}`);
  return {
    id,
    name: typeof r["name"] === "string" && r["name"].trim() ? r["name"].trim().slice(0, 100) : null,
    email: typeof r["email"] === "string" ? r["email"] : null,
    marketing_consent: typeof r["marketing_consent"] === "boolean" ? r["marketing_consent"] : null,
  };
}

/** 会員の独自項目を書く（customers:write）。鍵は Banto の「会員の項目」にあるものだけ（違えば 400） */
export async function setAttribute(deps: Deps, token: string, id: string, key: string, value: string): Promise<void> {
  await bantoApi(deps, token, "PATCH", `/customers/${encodeURIComponent(id)}`, { attributes: { [key]: value } });
}

/** 案内メールの同意を取り下げる（配信停止。true は API では書けない） */
export async function withdrawConsent(deps: Deps, token: string, id: string): Promise<void> {
  await bantoApi(deps, token, "PATCH", `/customers/${encodeURIComponent(id)}`, { marketing_consent: false });
}

export async function addOrderTags(deps: Deps, token: string, orderId: string, tags: string[]): Promise<void> {
  await bantoApi(deps, token, "PATCH", `/orders/${encodeURIComponent(orderId)}`, { add_tags: tags });
}

export interface CouponRef {
  id: string;
  name: string;
  active: boolean;
}

export async function listCoupons(deps: Deps, token: string): Promise<CouponRef[]> {
  const r = await bantoApi<{ items: unknown[] }>(deps, token, "GET", `/coupons?limit=100`);
  return (r.items ?? [])
    .map((x) => {
      const c = (x ?? {}) as Record<string, unknown>;
      return typeof c["id"] === "string" && typeof c["name"] === "string" ? { id: c["id"], name: c["name"].slice(0, 200), active: c["active"] !== false } : null;
    })
    .filter((c): c is CouponRef => !!c);
}

/**
 * 会員にクーポンを 1 枚配って、コードを返す（coupons:write）。もう持っている人は Banto が飛ばすので、持っている分を探して返す。
 * 見つからなければ null（コードを差し込めない）
 */
export async function grantCoupon(deps: Deps, token: string, couponId: string, customerId: string): Promise<string | null> {
  const r = await bantoApi<{ grants?: { code?: unknown; customer_id?: unknown }[] }>(deps, token, "POST", `/coupons/${encodeURIComponent(couponId)}/grants`, { customer_ids: [customerId] });
  const g = (r.grants ?? []).find((x) => x.customer_id === customerId);
  if (g && typeof g.code === "string") return g.code;
  for (let offset = 0; offset < 500; offset += 100) {
    const l = await bantoApi<{ items?: { code?: unknown; customer_id?: unknown }[]; total?: number }>(
      deps,
      token,
      "GET",
      `/coupons/${encodeURIComponent(couponId)}/grants?status=available&limit=100&offset=${offset}`,
    );
    const mine = (l.items ?? []).find((x) => x.customer_id === customerId);
    if (mine && typeof mine.code === "string") return mine.code;
    if ((l.items ?? []).length < 100) break;
  }
  return null;
}

export type LineResult = "sent" | "no_line" | "not_friend" | "quota";

/** Banto の公式アカウントから 1 通（line:send）。同じ鍵なら Banto は二重に送らない */
export async function sendLine(
  deps: Deps,
  token: string,
  customerId: string,
  key: string,
  body: { text: string; image_url?: string; buttons?: { text: string; actions: { label: string; url: string }[] } },
): Promise<LineResult> {
  const r = await bantoApi<{ status?: unknown }>(deps, token, "POST", `/customers/${encodeURIComponent(customerId)}/line-message`, body, { "Idempotency-Key": key });
  const s = r.status;
  return s === "sent" || s === "no_line" || s === "not_friend" || s === "quota" ? s : "no_line";
}

/** その会員のお気に入りの商品 ID（customers:read、新しい順に 200 まで） */
export async function customerFavorites(deps: Deps, token: string, customerId: string): Promise<Set<string>> {
  const r = await bantoApi<{ items?: { product_id?: unknown }[] }>(deps, token, "GET", `/customers/${encodeURIComponent(customerId)}/favorites`);
  return new Set((r.items ?? []).map((x) => x.product_id).filter((p): p is string => typeof p === "string"));
}
