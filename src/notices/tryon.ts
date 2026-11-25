/**
 * お店で試着のお知らせ（取引の知らせ、src/notices/kinds.ts）に使う申し込みと店舗。
 * 申し込みは Banto の GET /api/v1/tryon-requests/{受付番号}（orders:read、宛先とお名前は orders:contact）、
 * 店舗の住所・営業時間は GET /api/v1/stores（shop:read。無いつなぎ方では店舗の名前だけ）。
 * 読んだ値はこの送信の中だけで使い、D1 に置かない。
 * 営業時間の表し方は Banto（MIT）の src/modules/store-tryon/ の店舗の案内（曜日ごとの営業時間・近い臨時休業）にそろえる。
 */
import { bantoApi, BantoError } from "../banto/client";
import type { Deps } from "../deps";
import { escapeHtml, type Slots } from "../mail/html";

export interface TryonItemView {
  product_name: string;
  sku_name: string | null;
  qty: number;
}

export interface TryonView {
  id: string;
  number: number;
  status: string;
  store_id: string | null;
  store_name: string;
  /** YYYY-MM-DD */
  visit_date: string | null;
  hold_until: string | null;
  items: TryonItemView[];
  /** orders:contact（か orders:pii）が無ければ null */
  email: string | null;
  name: string | null;
  pii: boolean;
}

type TimeRange = [string, string];

export interface StoreView {
  name: string;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  /** 曜日 0（日）〜 6（土）→ 時間帯。空は休み */
  hours: Record<string, TimeRange[]>;
  special_days: { date: string; closed: boolean; hours: TimeRange[]; note: string | null }[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ymd = (v: unknown) => (typeof v === "string" && YMD.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

export function parseTryonView(r: Record<string, unknown>): TryonView | null {
  if (typeof r["id"] !== "string" || typeof r["number"] !== "number") return null;
  const c = r["customer"] && typeof r["customer"] === "object" ? (r["customer"] as Record<string, unknown>) : {};
  const pii = "email" in c;
  const items = Array.isArray(r["items"]) ? (r["items"] as Record<string, unknown>[]) : [];
  return {
    id: r["id"],
    number: r["number"],
    status: str(r["status"], 30) ?? "",
    store_id: str(r["store_id"], 100),
    store_name: str(r["store_name"], 100) ?? "店舗",
    visit_date: ymd(r["visit_date"]),
    hold_until: ymd(r["hold_until"]),
    items: items.slice(0, 50).map((i) => ({ product_name: str(i["product_name"]) ?? str(i["sku_name"]) ?? "商品", sku_name: str(i["sku_name"]), qty: int(i["qty"]) })),
    email: pii ? str(c["email"], 254) : null,
    name: pii ? str(c["name"], 100) : null,
    pii,
  };
}

function rangesOf(v: unknown): TimeRange[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is [string, string] => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string" && TIME.test(x[0]) && TIME.test(x[1]) && x[0] < x[1])
    .slice(0, 4)
    .map(([a, b]) => [a.padStart(5, "0"), b.padStart(5, "0")]);
}

export function parseStoreView(r: Record<string, unknown>): StoreView {
  const h = r["hours"] && typeof r["hours"] === "object" ? (r["hours"] as Record<string, unknown>) : {};
  const hours: Record<string, TimeRange[]> = {};
  for (let d = 0; d < 7; d++) hours[String(d)] = rangesOf(h[String(d)]);
  const special = Array.isArray(r["special_days"]) ? (r["special_days"] as unknown[]) : [];
  return {
    name: str(r["name"], 100) ?? "店舗",
    postal_code: str(r["postal_code"], 20),
    address: str(r["address"], 300),
    phone: str(r["phone"], 40),
    hours,
    special_days: special
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .filter((x) => typeof x["date"] === "string" && YMD.test(x["date"]))
      .map((x) => {
        const hs = rangesOf(x["hours"]);
        const closed = x["closed"] === true || hs.length === 0;
        return { date: x["date"] as string, closed, hours: closed ? [] : hs, note: str(x["note"], 50) };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export async function getTryonView(deps: Deps, token: string, number: number): Promise<TryonView | null> {
  return parseTryonView(await bantoApi<Record<string, unknown>>(deps, token, "GET", `/tryon-requests/${number}`));
}

/** 申し込みの店舗（shop:read が無い・見つからなければ null。そのときは店舗の名前だけを出す） */
export async function getStoreView(deps: Deps, token: string, storeId: string | null): Promise<StoreView | null> {
  if (!storeId) return null;
  let r: { stores?: unknown };
  try {
    r = await bantoApi<{ stores?: unknown }>(deps, token, "GET", "/stores");
  } catch (e) {
    // 権限が無い（前の版の手代でつないだ）。店舗の名前だけで送る
    if (e instanceof BantoError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
  const list = Array.isArray(r.stores) ? (r.stores as Record<string, unknown>[]) : [];
  const s = list.find((x) => x && x["id"] === storeId);
  return s ? parseStoreView(s) : null;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 10月20日（火） */
export function dateLabel(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  return `${t.getUTCMonth() + 1}月${t.getUTCDate()}日（${WEEKDAYS[t.getUTCDay()]}）`;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 日本時間の今日（手代の時刻はどこも日本時間） */
export const todayJst = (nowSeconds: number) => new Date((nowSeconds + 9 * 3600) * 1000).toISOString().slice(0, 10);
const rangesText = (rs: TimeRange[]) => rs.map(([a, b]) => `${a}〜${b}`).join(", ");

/** 店舗の案内の行（名前・住所・電話・曜日ごとの営業時間・45 日先までの臨時休業 / 臨時営業） */
function storeLines(name: string, store: StoreView | null, today: string): string[] {
  const lines = [`■ ${store?.name ?? name}`];
  if (!store) return lines;
  if (store.address) lines.push(`${store.postal_code ? `〒${store.postal_code} ` : ""}${store.address}`);
  if (store.phone) lines.push(`電話 ${store.phone}`);
  lines.push("営業時間:");
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const rs = store.hours[String(d)] ?? [];
    lines.push(`  ${WEEKDAYS[d]} ${rs.length ? rangesText(rs) : "定休日"}`);
  }
  const end = addDays(today, 45);
  const sp = store.special_days.filter((x) => x.date >= today && x.date <= end).slice(0, 15);
  if (sp.length > 0) {
    lines.push("臨時休業・臨時営業:");
    for (const x of sp) lines.push(`  ${dateLabel(x.date)} ${x.closed ? "休業" : rangesText(x.hours)}${x.note ? ` ${x.note}` : ""}`);
  }
  return lines;
}

const itemName = (i: TryonItemView) => (i.sku_name && i.sku_name !== i.product_name ? `${i.product_name}（${i.sku_name}）` : i.product_name);

/** {{tryon_items}}（品目）と {{store_info}}（店舗の案内）の中身 */
export function tryonSlots(t: TryonView, store: StoreView | null, today: string): Slots {
  const td = "padding:8px 0;border-bottom:1px solid #eeeeee;font-size:14px;line-height:1.6;color:#222222;vertical-align:top";
  const itemsHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">
<tr><td colspan="2" style="padding:0 0 8px;font-size:13px;color:#71717a">受付番号 ${t.number}</td></tr>
${t.items.map((i) => `<tr><td style="${td}">${escapeHtml(itemName(i))}</td><td align="right" style="${td};white-space:nowrap">× ${i.qty}</td></tr>`).join("\n")}
</table>`;
  const itemsText = [`受付番号: ${t.number}`, ...t.items.map((i) => `・${itemName(i)} × ${i.qty}`)].join("\n");
  const lines = storeLines(t.store_name, store, today);
  const storeHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse;background:#f7f7f5">
<tr><td style="padding:14px 16px;font-size:14px;line-height:1.8;color:#222222">${lines
    .map((l, i) => (i === 0 ? `<strong>${escapeHtml(l.replace(/^■ /, ""))}</strong>` : escapeHtml(l).replace(/^ {2}/, "&nbsp;&nbsp;")))
    .join("<br>")}</td></tr>
</table>`;
  return { tryon_items: { html: itemsHtml, text: itemsText }, store_info: { html: storeHtml, text: lines.join("\n") } };
}

/** 文字の差し込みの値 */
export function tryonValues(t: TryonView): Record<string, string> {
  return {
    tryon_number: String(t.number),
    store_name: t.store_name,
    hold_until: t.hold_until ? dateLabel(t.hold_until) : "",
    visit: t.visit_date ? `ご来店予定日: ${dateLabel(t.visit_date)}` : "",
  };
}

/** 見本の申し込み（画面の見本と試し送り） */
export const SAMPLE_TRYON: TryonView = {
  id: "sample",
  number: 2001,
  status: "ready",
  store_id: "sample-store",
  store_name: "渋谷店",
  visit_date: "2026-12-05",
  hold_until: "2026-12-08",
  items: [
    { product_name: "リネンシャツ", sku_name: "白 / M", qty: 1 },
    { product_name: "ウールのパンツ", sku_name: "グレー / 76", qty: 1 },
  ],
  email: null,
  name: "山田 花子",
  pii: true,
};

export const SAMPLE_STORE: StoreView = {
  name: "渋谷店",
  postal_code: "150-0000",
  address: "東京都渋谷区〇〇 1-2-3",
  phone: "03-0000-0000",
  hours: { "0": [["11:00", "19:00"]], "1": [["11:00", "20:00"]], "2": [], "3": [["11:00", "20:00"]], "4": [["11:00", "20:00"]], "5": [["11:00", "20:00"]], "6": [["11:00", "19:00"]] },
  special_days: [],
};
