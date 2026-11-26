/**
 * お支払いのお願い（取引の知らせ、src/notices/kinds.ts の payment_reminder）に使う予約。
 * Banto の hooks checkout.payment_pending（0181、KOMOJU の未払いの予約に 24 時間後に 1 回）の reservation_id で、
 * GET /api/v1/reservations/{id}/payment-reminder（0182、orders:read。宛先・お名前とお支払いに進むリンクは orders:contact）を読む。
 * 確定した・取りやめた・期限が切れた予約は 404（送らない合図）。読んだ値はこの送信の中だけで使い、D1 に置かない。
 */
import { bantoApi } from "../banto/client";
import type { Deps } from "../deps";
import { escapeHtml, type Slots } from "../mail/html";
import { yen } from "./order";

export interface ReminderItemView {
  product_name: string;
  sku_name: string | null;
  qty: number;
  unit_price_jpy: number;
}

export interface ReminderView {
  reservation_id: string;
  total_jpy: number;
  /** お支払いの期限の文（Banto が運営者の時間帯で作る。「11月28日（金）15:00」） */
  pay_until: string;
  payment_method: string | null;
  items: ReminderItemView[];
  /** orders:contact（か orders:pii）が無ければ null */
  email: string | null;
  name: string | null;
  /** お支払いに進む・取りやめる画面（券つき）。orders:contact が無い・Banto が組めないときは null */
  payment_link: string | null;
  pii: boolean;
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function parseReminderView(r: Record<string, unknown>): ReminderView | null {
  if (typeof r["reservation_id"] !== "string") return null;
  const items = Array.isArray(r["items"]) ? (r["items"] as Record<string, unknown>[]) : [];
  const link = str(r["payment_link"], 1000);
  return {
    reservation_id: r["reservation_id"],
    total_jpy: int(r["total_jpy"]),
    pay_until: str(r["pay_until"], 60) ?? "",
    payment_method: str(r["payment_method"], 60),
    items: items.slice(0, 50).map((i) => ({ product_name: str(i["product_name"]) ?? str(i["sku_name"]) ?? "商品", sku_name: str(i["sku_name"]), qty: int(i["qty"]), unit_price_jpy: int(i["unit_price_jpy"]) })),
    email: "email" in r ? str(r["email"], 254) : null,
    name: "email" in r ? str(r["name"], 100) : null,
    payment_link: link && /^https:\/\//.test(link) ? link : null,
    pii: "email" in r,
  };
}

export async function getReminderView(deps: Deps, token: string, reservationId: string): Promise<ReminderView | null> {
  return parseReminderView(await bantoApi<Record<string, unknown>>(deps, token, "GET", `/reservations/${encodeURIComponent(reservationId)}/payment-reminder`));
}

/** KOMOJU の支払いの種類（予約の payment_method は komoju:<種類>） */
const KOMOJU_TYPES: Record<string, string> = {
  konbini: "コンビニ払い",
  bank_transfer: "銀行振込",
  pay_easy: "ペイジー",
  credit_card: "クレジットカード",
  paypay: "PayPay",
};

export function reminderMethodLabel(m: string | null): string {
  if (!m) return "";
  const t = m.startsWith("komoju:") ? m.slice(7) : m;
  return KOMOJU_TYPES[t] ?? t;
}

const itemName = (i: ReminderItemView) => (i.sku_name && i.sku_name !== i.product_name ? `${i.product_name}（${i.sku_name}）` : i.product_name);

/** {{items}}（品目と合計）の中身 */
export function reminderSlots(r: ReminderView): Slots {
  const td = "padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;line-height:1.6;color:#222222;vertical-align:top";
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">
${r.items.map((i) => `<tr><td style="${td}">${escapeHtml(itemName(i))} × ${i.qty}</td><td align="right" style="${td};white-space:nowrap">${yen(i.unit_price_jpy * i.qty)}</td></tr>`).join("\n")}
<tr><td style="padding:8px 0;border-top:2px solid #222222;font-size:15px;font-weight:bold;color:#111111">お支払い金額（税込）</td><td align="right" style="padding:8px 0;border-top:2px solid #222222;font-size:15px;font-weight:bold;color:#111111;white-space:nowrap">${yen(r.total_jpy)}</td></tr>
</table>`;
  const text = [...r.items.map((i) => `・${itemName(i)} × ${i.qty}　${yen(i.unit_price_jpy * i.qty)}`), "――――――――――", `お支払い金額（税込）: ${yen(r.total_jpy)}`].join("\n");
  return { items: { html, text } };
}

/** 文字の差し込みの値 */
export function reminderValues(r: ReminderView): Record<string, string> {
  return { total: yen(r.total_jpy), pay_until: r.pay_until, payment_method: reminderMethodLabel(r.payment_method), payment_link: r.payment_link ?? "" };
}

/** 見本の予約（画面の見本と試し送り） */
export const SAMPLE_REMINDER: ReminderView = {
  reservation_id: "sample",
  total_jpy: 9400,
  pay_until: "11月28日（土）15:00",
  payment_method: "komoju:konbini",
  items: [{ product_name: "リネンシャツ", sku_name: "白 / M", qty: 1, unit_price_jpy: 8800 }],
  email: null,
  name: "山田 花子",
  payment_link: "https://banto.example/shop/checkout/resume?t=sample",
  pii: true,
};
