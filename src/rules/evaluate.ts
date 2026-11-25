/**
 * 条件に当たる会員を D1 の購入の記録だけで数える（Banto には聞かない）。キャンセル・返金された注文は数えない。
 * 「条件に入った」は、その注文を入れると当たり、その注文を除くと当たらないこと。
 */
import type { SqlDb, SqlValue } from "../store/sql";
import type { Condition } from "./condition";

interface Scope {
  shopId: string;
  now: number;
  /** この会員だけ */
  customerId?: string;
  /** この注文を除いて数える */
  excludeOrderId?: string;
}

function orderFilter(alias: string, s: Scope, days: number | null, params: SqlValue[]): string {
  let w = `${alias}.shop_id = ? AND ${alias}.cancelled = 0`;
  params.push(s.shopId);
  if (s.customerId) {
    w += ` AND ${alias}.customer_id = ?`;
    params.push(s.customerId);
  }
  if (s.excludeOrderId) {
    w += ` AND ${alias}.order_id <> ?`;
    params.push(s.excludeOrderId);
  }
  if (days) {
    w += ` AND ${alias}.ordered_at >= ?`;
    params.push(s.now - days * 86400);
  }
  return w;
}

/** 条件に当たる会員の ID を選ぶ SQL（customer_id の 1 列） */
export function matchSql(c: Condition, s: Scope): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  const parts: string[] = [];
  if (c.purchase) {
    const p = c.purchase;
    const wp: SqlValue[] = [];
    const where = orderFilter("o", s, p.days, wp);
    // SQL に出てくる順に値を積む（join の set_id → where → having）
    params.push(p.set_id, ...wp);
    const join = `FROM orders o JOIN order_products op ON op.shop_id = o.shop_id AND op.order_id = o.order_id
      JOIN product_set_items si ON si.shop_id = op.shop_id AND si.product_id = op.product_id AND si.set_id = ?`;
    if (p.mode === "all_in_one_order") {
      parts.push(`SELECT o.customer_id ${join} WHERE ${where} GROUP BY o.order_id, o.customer_id
        HAVING COUNT(DISTINCT op.product_id) = (SELECT COUNT(*) FROM product_set_items WHERE shop_id = ? AND set_id = ?)`);
      params.push(s.shopId, p.set_id);
    } else {
      const agg = p.mode === "distinct_at_least" ? "COUNT(DISTINCT op.product_id)" : "SUM(op.qty)";
      parts.push(`SELECT o.customer_id ${join} WHERE ${where} GROUP BY o.customer_id HAVING ${agg} >= ?`);
      params.push(p.n);
    }
  }
  if (c.orders_at_least) {
    const where = orderFilter("o", s, c.orders_at_least.days, params);
    parts.push(`SELECT o.customer_id FROM orders o WHERE ${where} GROUP BY o.customer_id HAVING COUNT(*) >= ?`);
    params.push(c.orders_at_least.n);
  }
  if (c.spend_at_least) {
    const where = orderFilter("o", s, c.spend_at_least.days, params);
    parts.push(`SELECT o.customer_id FROM orders o WHERE ${where} GROUP BY o.customer_id HAVING SUM(o.total_jpy) >= ?`);
    params.push(c.spend_at_least.yen);
  }
  if (parts.length === 0) return { sql: `SELECT NULL AS customer_id WHERE 0`, params: [] };
  return { sql: parts.join(" INTERSECT "), params };
}

/** 今当たる会員の数と、見本の会員 ID（10 人まで） */
export async function preview(db: SqlDb, c: Condition, shopId: string, now: number): Promise<{ count: number; sample: string[] }> {
  const m = matchSql(c, { shopId, now });
  const r = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM (${m.sql})`, m.params);
  const sample = await db.all<{ customer_id: string }>(`SELECT customer_id FROM (${m.sql}) ORDER BY customer_id LIMIT 10`, m.params);
  return { count: r?.n ?? 0, sample: sample.map((x) => x.customer_id) };
}

/** この注文で条件に入ったか（その注文を入れると当たり、除くと当たらない）。クエリは 1 回 */
export async function enteredBy(db: SqlDb, c: Condition, shopId: string, customerId: string, orderId: string, now: number): Promise<boolean> {
  const a = matchSql(c, { shopId, now, customerId });
  const b = matchSql(c, { shopId, now, customerId, excludeOrderId: orderId });
  const r = await db.first<{ now_ok: number; before_ok: number }>(
    `SELECT EXISTS (SELECT 1 FROM (${a.sql})) AS now_ok, EXISTS (SELECT 1 FROM (${b.sql})) AS before_ok`,
    [...a.params, ...b.params],
  );
  return !!r && r.now_ok === 1 && r.before_ok === 0;
}

/** 今もこの会員が条件を満たしているか（待ったあとの確かめ直し） */
export async function stillMatches(db: SqlDb, c: Condition, shopId: string, customerId: string, now: number): Promise<boolean> {
  if (!hasParts(c)) return true;
  const m = matchSql(c, { shopId, now, customerId });
  const r = await db.first<{ ok: number }>(`SELECT EXISTS (SELECT 1 FROM (${m.sql})) AS ok`, m.params);
  return r?.ok === 1;
}

/** 条件の部品が 1 つでもあるか（時刻のきっかけは条件なしでもよい） */
export const hasParts = (c: Condition) => !!(c.purchase || c.orders_at_least || c.spend_at_least);

/** 試しに当てる（カゴ落ち）: 手代が注文を記録している会員のうち、条件を満たす会員（条件が無ければ全員） */
export async function previewCustomers(db: SqlDb, c: Condition, shopId: string, now: number): Promise<{ count: number; sample: string[] }> {
  if (hasParts(c)) return preview(db, c, shopId, now);
  const n = await db.first<{ n: number }>(`SELECT COUNT(DISTINCT customer_id) AS n FROM orders WHERE shop_id = ?`, [shopId]);
  const sample = await db.all<{ customer_id: string }>(`SELECT customer_id FROM orders WHERE shop_id = ? GROUP BY customer_id ORDER BY MAX(ordered_at) DESC LIMIT 10`, [shopId]);
  return { count: n?.n ?? 0, sample: sample.map((x) => x.customer_id) };
}
