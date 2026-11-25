/**
 * きっかけ「注文が支払われた」: 会員の注文を記録したあと、動いているルールを確かめ、この注文で条件に入ったら記録する。
 * 同じ人に同じルールは 1 回（rule_hits の主キー）。hooks と取りこぼしの読み直しの両方から呼ばれても重ならない。
 * 「動かす」ルールは、当たったらアクションの列（runs）に積む。行うのは Cron（src/runs/execute.ts）で、hooks の受け口では行わない（10 秒で返すため）。
 */
import { sha256Hex } from "../crypto";
import type { SqlDb, SqlStatement } from "../store/sql";
import { listRules, type Rule } from "../store/rules";
import { MAX_RUNNING_RULES, RUNNING_STATUSES } from "./condition";
import { enteredBy } from "./evaluate";

/** ルール × 当たりの鍵（ふつうは会員）の列の ID（同じ組は 1 行。Banto の LINE の Idempotency-Key にも使う） */
export const runId = async (ruleId: string, hitKey: string) => (await sha256Hex(`${ruleId}|${hitKey}`)).slice(0, 32);

/** 当たった記録と、「動かす」ならアクションの列（同じ鍵は 1 回だけ） */
export async function hitStatements(
  rule: Rule,
  shopId: string,
  h: { customerId: string; orderId: string | null; productId?: string | null; hitKey?: string; variant?: Record<string, string> | null; refAt?: number | null; minDelay?: number },
  now: number,
): Promise<SqlStatement[]> {
  const key = h.hitKey ?? h.customerId;
  const variant = h.variant && Object.keys(h.variant).length > 0 ? JSON.stringify(h.variant) : null;
  const out: SqlStatement[] = [
    {
      // 退会した会員には当てない（src/store/purchases.ts forgetCustomer）
      sql: `INSERT OR IGNORE INTO rule_hits (shop_id, rule_id, hit_key, customer_id, order_id, product_id, variant, hit_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM forgotten_customers WHERE shop_id = ? AND customer_id = ?)`,
      params: [shopId, rule.id, key, h.customerId, h.orderId, h.productId ?? null, variant, now, shopId, h.customerId],
    },
  ];
  if (rule.status === "active") {
    out.push({
      sql: `INSERT OR IGNORE INTO runs (shop_id, id, rule_id, customer_id, order_id, product_id, variant, ref_at, status, due_at, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM forgotten_customers WHERE shop_id = ? AND customer_id = ?)`,
      params: [shopId, await runId(rule.id, key), rule.id, h.customerId, h.orderId, h.productId ?? null, variant, h.refAt ?? null, now + Math.max(rule.actions.wait_days * 86400, h.minDelay ?? 0), now, now, shopId, h.customerId],
    });
  }
  return out;
}

/** きっかけが「注文が支払われた」の動いているルール */
export async function orderPaidRules(db: SqlDb, shopId: string): Promise<Rule[]> {
  return (await listRules(db, shopId, RUNNING_STATUSES)).filter((r) => r.trigger.kind === "order.paid").slice(0, MAX_RUNNING_RULES);
}

/** この注文で条件に入ったルールと、その当たりの書き込み（書くのは呼ぶ側。D1 はルールの数だけ読む） */
export async function orderPaidStatements(db: SqlDb, rules: Rule[], shopId: string, customerId: string, orderId: string, now: number): Promise<{ hit: string[]; statements: SqlStatement[] }> {
  const hit: string[] = [];
  const statements: SqlStatement[] = [];
  for (const r of rules) {
    if (!(await enteredBy(db, r.condition, shopId, customerId, orderId, now))) continue;
    hit.push(r.id);
    statements.push(...(await hitStatements(r, shopId, { customerId, orderId }, now)));
  }
  return { hit, statements };
}

/** extra: 当たりと同じ取引で書くもの（hooks の受け口の「確かめた」印など） */
export async function onOrderPaid(db: SqlDb, shopId: string, customerId: string, orderId: string, now: number, extra: SqlStatement[] = []): Promise<string[]> {
  const { hit, statements } = await orderPaidStatements(db, await orderPaidRules(db, shopId), shopId, customerId, orderId, now);
  if (statements.length + extra.length > 0) await db.batch([...statements, ...extra]);
  return hit;
}
