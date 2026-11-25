/**
 * Banto に見せるマニフェスト（Banto の docs/hooks.md §4・§6）。受け口の URL に GET（Accept: application/json）で返す。
 * スコープは v0.1.0 で使う分を最初から求める（Banto はマニフェストを取り直しても権限を広げないため、後から足すとつなぎ直しが要る）。
 */
import { VERSION } from "./deps";

/**
 * 受け取る出来事。Banto はマニフェストを取り直しても、購読する出来事は変えない（つないだときに決まる）。
 * 後から足した出来事（checkout.abandoned）は、前からつないでいる連携では Banto の連携の画面で選び直してもらう必要がある。
 */
export const EVENTS = [
  "order.created", // 取引の知らせ: 未入金の注文（代金引換など）の受付
  "order.paid",
  "order.shipped", // 取引の知らせ: 発送
  "order.cancelled",
  "customer.deleted",
  "favorite.added",
  "favorite.removed",
  "product.updated",
  "inventory.low",
  "checkout.abandoned",
  "tryon.requested", // 取引の知らせ: お店で試着のお申し込みの受付
  "tryon.updated", // 取引の知らせ: お店で試着の取り置き・期限の前日・延長・取り消し
] as const;

export const SCOPES = [
  "orders:read", // 注文の明細（会員 ID・商品 ID）を引き直す
  "orders:write", // 注文に印を付ける
  // 取引の知らせ: 送る直前に注文の宛先（メールアドレス）とお名前を読む（ゲストの注文は注文にしかアドレスが無い）。
  // Banto 0173 から。住所と社内のメモは要らないので orders:pii は求めない（前の版でつないだ orders:pii もそのまま使える）
  "orders:contact",
  "products:read", // 商品の集まりを選ぶ・お気に入りの商品の在庫と価格を読む
  "customers:read", // 送る直前に宛先と案内メールの同意を読む・お気に入りを読む
  "customers:write", // 会員の独自項目を書く・配信停止で同意を取り下げる
  "coupons:read",
  "coupons:write", // 会員にクーポンを配る
  "line:send", // Banto の公式アカウントから LINE で送る
  "shop:read", // お店で試着の知らせ: 店舗の住所・営業時間を読む（無いつなぎ方では店舗の名前だけ）
] as const;

export function manifest(origin: string) {
  return {
    name: "手代",
    version: VERSION,
    description: "注文のお知らせ（受付・発送など）のメールと、お客様の購入に応じて決めておいたアプローチ（LINE・メール・クーポン・会員の項目）・お店の作業（注文に印・知らせ）を自動で行います。",
    events: [...EVENTS],
    connect_url: `${origin}/connect`,
    admin_url: `${origin}/admin`,
    scopes: [...SCOPES],
  };
}
