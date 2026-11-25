/**
 * 知らせに使う注文（Banto の GET /api/v1/orders/{id}）。宛先とお名前は orders:pii があるときだけ返る。
 * 読んだ値はこの送信の中だけで使い、D1 に置かない。
 */
import { bantoApi } from "../banto/client";
import type { Deps } from "../deps";
import { escapeHtml, type Slots } from "../mail/html";

export interface OrderItemView {
  product_name: string;
  sku_name: string | null;
  qty: number;
  unit_price_jpy: number;
}

export interface OrderView {
  id: string;
  number: number;
  status: string;
  payment_status: string;
  payment_provider: string;
  customer_id: string | null;
  items: OrderItemView[];
  discount_jpy: number;
  discounts: { name: string; amount_jpy: number }[];
  shipping_jpy: number;
  fee_jpy: number;
  total_jpy: number;
  /** orders:pii が無ければ null（masked） */
  email: string | null;
  name: string | null;
  pii: boolean;
  /** 発送のお問い合わせ番号（Banto 0172 から、orders:read）。無い・古い Banto なら null */
  tracking: { carrier_label: string; number: string; url: string | null } | null;
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function parseOrderView(r: Record<string, unknown>): OrderView | null {
  if (typeof r["id"] !== "string" || typeof r["number"] !== "number") return null;
  const c = r["customer"] && typeof r["customer"] === "object" ? (r["customer"] as Record<string, unknown>) : {};
  const pii = c["masked"] !== true && "email" in c;
  const items = Array.isArray(r["items"]) ? (r["items"] as Record<string, unknown>[]) : [];
  const discounts = Array.isArray(r["discounts"]) ? (r["discounts"] as Record<string, unknown>[]) : [];
  return {
    id: r["id"],
    number: r["number"],
    status: str(r["status"], 30) ?? "",
    payment_status: str(r["payment_status"], 30) ?? "paid",
    payment_provider: str(r["payment_provider"], 30) ?? "",
    customer_id: str(r["customer_id"], 100),
    items: items.map((i) => ({ product_name: str(i["product_name"]) ?? str(i["sku_name"]) ?? "商品", sku_name: str(i["sku_name"]), qty: int(i["qty"]), unit_price_jpy: int(i["unit_price_jpy"]) })),
    discount_jpy: int(r["discount_jpy"]),
    discounts: discounts.map((d) => ({ name: str(d["name"]) ?? str(d["code"]) ?? "値引き", amount_jpy: int(d["amount_jpy"]) })),
    shipping_jpy: int(r["shipping_jpy"]),
    fee_jpy: int(r["fee_jpy"]),
    total_jpy: int(r["total_jpy"]),
    email: pii ? str(c["email"], 254) : null,
    name: pii ? str(c["name"], 100) : null,
    pii,
    tracking: parseTracking(r["tracking"]),
  };
}

function parseTracking(v: unknown): OrderView["tracking"] {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const number = str(t["number"], 60);
  if (!number) return null;
  const url = str(t["url"], 500);
  return { carrier_label: str(t["carrier_label"], 60) ?? str(t["carrier"], 30) ?? "運送会社", number, url: url && /^https:\/\//.test(url) ? url : null };
}

export async function getOrderView(deps: Deps, token: string, orderId: string): Promise<OrderView | null> {
  return parseOrderView(await bantoApi<Record<string, unknown>>(deps, token, "GET", `/orders/${encodeURIComponent(orderId)}`));
}

export const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

const PROVIDERS: Record<string, string> = {
  stripe: "クレジットカードなど",
  komoju: "KOMOJU（コンビニ・銀行振込など）",
  amazon_pay: "Amazon Pay",
  cod: "代金引換",
  free: "お支払いなし（0 円）",
};

export function paymentLabel(o: Pick<OrderView, "payment_provider" | "payment_status">): string {
  const base = PROVIDERS[o.payment_provider] ?? (o.payment_provider || "—");
  return o.payment_status === "unpaid" ? `${base}（未入金）` : base;
}

/** 明細の行（商品名・オプション・数・金額）と合計の行 */
function rows(o: OrderView) {
  const lines = o.items.map((i) => ({
    name: i.sku_name && i.sku_name !== i.product_name ? `${i.product_name}（${i.sku_name}）` : i.product_name,
    qty: i.qty,
    amount: i.unit_price_jpy * i.qty,
  }));
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const totals: [string, string][] = [["小計", yen(subtotal)]];
  if (o.discounts.length > 0) for (const d of o.discounts) totals.push([`値引き（${d.name}）`, `-${yen(d.amount_jpy)}`]);
  else if (o.discount_jpy > 0) totals.push(["値引き", `-${yen(o.discount_jpy)}`]);
  totals.push(["送料", yen(o.shipping_jpy)]);
  if (o.fee_jpy > 0) totals.push([o.payment_provider === "cod" ? "代引き手数料" : "手数料", yen(o.fee_jpy)]);
  return { lines, totals };
}

/**
 * {{tracking}} の中身（運送会社・お問い合わせ番号・追跡のリンク）。番号の無い注文（まだ入れていない・古い Banto）は、
 * ご注文の確認ページ（番号が入ればそこに出る）を案内する
 */
function trackingSlot(o: OrderView, orderUrl: string): { html: string; text: string } {
  const t = o.tracking;
  const p = "margin:0 0 16px;font-size:15px;line-height:1.8;color:#222222";
  if (!t) {
    return {
      html: `<p style="${p}">お問い合わせ番号は、<a href="${escapeHtml(orderUrl)}" style="color:#1d4ed8;text-decoration:underline">ご注文の確認ページ</a>でご覧いただけます。</p>`,
      text: `お問い合わせ番号は、ご注文の確認ページでご覧いただけます。\n${orderUrl}`,
    };
  }
  const link = t.url ? `<br><a href="${escapeHtml(t.url)}" style="color:#1d4ed8;text-decoration:underline">配送の状況を見る（${escapeHtml(t.carrier_label)}）</a>` : "";
  return {
    html: `<p style="${p}">配送: ${escapeHtml(t.carrier_label)}<br>お問い合わせ番号: <strong>${escapeHtml(t.number)}</strong>${link}</p>`,
    text: [`配送: ${t.carrier_label}`, `お問い合わせ番号: ${t.number}`, ...(t.url ? [`配送の状況: ${t.url}`] : [])].join("\n"),
  };
}

/** {{order_details}}（HTML の表と文字の表）と {{tracking}} の中身 */
export function orderSlots(o: OrderView, orderUrl = ""): Slots {
  const { lines, totals } = rows(o);
  const td = "padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;line-height:1.6;color:#222222;vertical-align:top";
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">
<tr><td colspan="2" style="padding:0 0 8px;font-size:13px;color:#71717a">注文番号 ${o.number}</td></tr>
${lines.map((l) => `<tr><td style="${td}">${escapeHtml(l.name)} × ${l.qty}</td><td align="right" style="${td};white-space:nowrap">${yen(l.amount)}</td></tr>`).join("\n")}
${totals.map(([k, v]) => `<tr><td style="padding:4px 0;font-size:14px;color:#52525b">${escapeHtml(k)}</td><td align="right" style="padding:4px 0;font-size:14px;color:#52525b;white-space:nowrap">${escapeHtml(v)}</td></tr>`).join("\n")}
<tr><td style="padding:8px 0;border-top:2px solid #222222;font-size:15px;font-weight:bold;color:#111111">合計（税込）</td><td align="right" style="padding:8px 0;border-top:2px solid #222222;font-size:15px;font-weight:bold;color:#111111;white-space:nowrap">${yen(o.total_jpy)}</td></tr>
<tr><td colspan="2" style="padding:4px 0;font-size:13px;color:#71717a">お支払い: ${escapeHtml(paymentLabel(o))}</td></tr>
</table>`;
  const text = [
    `注文番号: ${o.number}`,
    "――――――――――",
    ...lines.map((l) => `${l.name} × ${l.qty}　${yen(l.amount)}`),
    "――――――――――",
    ...totals.map(([k, v]) => `${k}: ${v}`),
    `合計（税込）: ${yen(o.total_jpy)}`,
    `お支払い: ${paymentLabel(o)}`,
  ].join("\n");
  return { order_details: { html, text }, tracking: trackingSlot(o, orderUrl) };
}

/** 見本の注文（画面の見本と試し送り） */
export const SAMPLE_ORDER: OrderView = {
  id: "sample",
  number: 1001,
  status: "paid",
  payment_status: "paid",
  payment_provider: "stripe",
  customer_id: null,
  items: [
    { product_name: "リネンシャツ", sku_name: "白 / M", qty: 1, unit_price_jpy: 8800 },
    { product_name: "コットンの靴下", sku_name: null, qty: 2, unit_price_jpy: 1100 },
  ],
  discount_jpy: 1000,
  discounts: [{ name: "WELCOME", amount_jpy: 1000 }],
  shipping_jpy: 600,
  fee_jpy: 0,
  total_jpy: 10600,
  email: null,
  name: "山田 花子",
  pii: true,
  tracking: { carrier_label: "ヤマト運輸", number: "123456789012", url: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko" },
};
