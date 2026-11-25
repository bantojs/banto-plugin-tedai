/**
 * 会員の購入の記録。hooks（order.paid / order.cancelled / customer.deleted）と、Cron の取りこぼしの読み直しの両方がここを通る。
 * 置くのは ID・数・金額・時刻だけ（個人情報なし）。
 */
import type { SqlDb, SqlStatement } from "./sql";

export interface OrderItemIn {
  product_id: string;
  qty: number;
  unit_price_jpy: number;
  discount_jpy?: number;
}

export interface OrderIn {
  order_id: string;
  customer_id: string | null;
  total_jpy: number;
  ordered_at: number;
  cancelled: boolean;
  items: OrderItemIn[];
  /** Banto の注文の updated_at（読み直しのときだけ。hooks では null） */
  banto_updated_at: string | null;
  /** すべての明細に商品 ID があった（無い明細があれば、ルールは読み直しのほうで確かめる） */
  complete: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** Banto の注文（hooks の data・API の注文）から読む。読めない形・ゲストの注文は null */
export function parseOrder(raw: Record<string, unknown>, opts: { orderedAt: number; cancelled: boolean; bantoUpdatedAt: string | null }): OrderIn | null {
  const order_id = typeof raw["order_id"] === "string" ? raw["order_id"] : typeof raw["id"] === "string" ? raw["id"] : null;
  const customer_id = typeof raw["customer_id"] === "string" ? raw["customer_id"] : null;
  if (!order_id || !ID_RE.test(order_id) || !customer_id || !ID_RE.test(customer_id)) return null;
  if (!Array.isArray(raw["items"])) return null;
  const items: OrderItemIn[] = [];
  let complete = true;
  for (const x of raw["items"] as unknown[]) {
    if (!x || typeof x !== "object") return null;
    const it = x as Record<string, unknown>;
    const product_id = typeof it["product_id"] === "string" && ID_RE.test(it["product_id"]) ? it["product_id"] : null;
    const qty = int(it["qty"]);
    const unit = int(it["unit_price_jpy"]);
    // 商品 ID の無い明細（消えた SKU・商品 ID を載せない古い Banto の hooks）は数えない
    if (!product_id || qty === null || qty <= 0 || unit === null) {
      complete = false;
      continue;
    }
    items.push({ product_id, qty, unit_price_jpy: unit, discount_jpy: int(it["discount_jpy"]) ?? 0 });
  }
  return { order_id, customer_id, total_jpy: int(raw["total_jpy"]) ?? 0, ordered_at: opts.orderedAt, cancelled: opts.cancelled, items, banto_updated_at: opts.bantoUpdatedAt, complete };
}

/** 1 件分の文（まとめて batch で流す）。注文の明細は置き換える */
export function orderStatements(shopId: string, o: OrderIn): SqlStatement[] {
  if (!o.customer_id) return [];
  const byProduct = new Map<string, { qty: number; amount: number }>();
  for (const it of o.items) {
    const cur = byProduct.get(it.product_id) ?? { qty: 0, amount: 0 };
    cur.qty += it.qty;
    cur.amount += it.qty * it.unit_price_jpy - (it.discount_jpy ?? 0);
    byProduct.set(it.product_id, cur);
  }
  return [
    {
      // 退会した会員の注文は戻さない（hooks の再送・読み直しのどちらから来ても。src/store/purchases.ts forgetCustomer）
      sql: `INSERT INTO orders (shop_id, order_id, customer_id, total_jpy, ordered_at, cancelled, banto_updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM forgotten_customers WHERE shop_id = ? AND customer_id = ?)
            ON CONFLICT(shop_id, order_id) DO UPDATE SET customer_id = excluded.customer_id, total_jpy = excluded.total_jpy,
              cancelled = MAX(orders.cancelled, excluded.cancelled), banto_updated_at = COALESCE(excluded.banto_updated_at, orders.banto_updated_at)`,
      params: [shopId, o.order_id, o.customer_id, o.total_jpy, o.ordered_at, o.cancelled ? 1 : 0, o.banto_updated_at, shopId, o.customer_id],
    },
    { sql: `DELETE FROM order_products WHERE shop_id = ? AND order_id = ?`, params: [shopId, o.order_id] },
    ...[...byProduct].map(([product_id, v]) => ({
      sql: `INSERT INTO order_products (shop_id, order_id, product_id, qty, amount_jpy)
            SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE shop_id = ? AND order_id = ?)`,
      params: [shopId, o.order_id, product_id, v.qty, v.amount, shopId, o.order_id],
    })),
  ];
}

export async function recordOrder(db: SqlDb, shopId: string, o: OrderIn): Promise<void> {
  const st = orderStatements(shopId, o);
  if (st.length > 0) await db.batch(st);
}

/** キャンセル・返金された注文は数えない（行は残し、印だけ付ける） */
/**
 * hooks で受け取り、その場でルールを確かめた注文の印（orders.banto_updated_at）。取りこぼしの読み直しは、この印の注文を
 * 「初めて見た注文」として当て直さない（hooks で明細が足りず確かめられなかった注文は null のまま）
 */
export const HOOK_TRIGGERED = "hook";

export async function cancelOrder(db: SqlDb, shopId: string, orderId: string): Promise<boolean> {
  return (await db.run(`UPDATE orders SET cancelled = 1 WHERE shop_id = ? AND order_id = ?`, [shopId, orderId])).changes > 0;
}

/** 退会した会員の記録を全部消す（購入・お気に入り・ルールに当たった記録・アクションの列） */
export async function forgetCustomer(db: SqlDb, shopId: string, customerId: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  // 取りこぼした注文の一覧（src/sync.ts の kv）からも外す
  const lateKey = `late_orders:${shopId}`;
  const raw = (await db.first<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [lateKey]))?.value;
  let late: { customer_id?: unknown }[] = [];
  try {
    late = raw ? (JSON.parse(raw) as { customer_id?: unknown }[]) : [];
  } catch {
    late = [];
  }
  const kept = Array.isArray(late) ? late.filter((x) => x && x.customer_id !== customerId) : [];
  await db.batch([
    // 退会した印（ID だけ）。Banto に残る注文を読み直しても、記録を戻さない
    { sql: `INSERT OR IGNORE INTO forgotten_customers (shop_id, customer_id, at) VALUES (?, ?, ?)`, params: [shopId, customerId, now] },
    ...(raw !== undefined && Array.isArray(late) && kept.length !== late.length
      ? [kept.length > 0 ? { sql: `UPDATE kv SET value = ? WHERE key = ?`, params: [JSON.stringify(kept), lateKey] } : { sql: `DELETE FROM kv WHERE key = ?`, params: [lateKey] }]
      : []),
    { sql: `DELETE FROM favorites WHERE shop_id = ? AND customer_id = ?`, params: [shopId, customerId] },
    { sql: `DELETE FROM rule_hits WHERE shop_id = ? AND customer_id = ?`, params: [shopId, customerId] },
    { sql: `DELETE FROM runs WHERE shop_id = ? AND customer_id = ?`, params: [shopId, customerId] },
    { sql: `DELETE FROM order_products WHERE shop_id = ? AND order_id IN (SELECT order_id FROM orders WHERE shop_id = ? AND customer_id = ?)`, params: [shopId, shopId, customerId] },
    { sql: `DELETE FROM orders WHERE shop_id = ? AND customer_id = ?`, params: [shopId, customerId] },
  ]);
}

/** 退会した会員の ID のうち、ids にあるもの */
export async function forgottenAmong(db: SqlDb, shopId: string, ids: string[]): Promise<Set<string>> {
  const uniq = [...new Set(ids)].slice(0, 90);
  if (uniq.length === 0) return new Set();
  const rows = await db.all<{ customer_id: string }>(`SELECT customer_id FROM forgotten_customers WHERE shop_id = ? AND customer_id IN (${uniq.map(() => "?").join(",")})`, [shopId, ...uniq]);
  return new Set(rows.map((r) => r.customer_id));
}

export async function purchaseStats(db: SqlDb, shopId: string): Promise<{ orders: number; customers: number }> {
  const r = await db.first<{ orders: number; customers: number }>(
    `SELECT COUNT(*) AS orders, COUNT(DISTINCT customer_id) AS customers FROM orders WHERE shop_id = ? AND cancelled = 0`,
    [shopId],
  );
  return r ?? { orders: 0, customers: 0 };
}
