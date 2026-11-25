/**
 * 時刻のきっかけ（最後の購入から n 日・初めての購入から n 日）。Cron で 5 分ごとに、ルールごとに
 * 「前に見たとき（scanned_until）から今までに、ちょうど n 日を過ぎた会員」を探して当てる。
 * - 動かし始めたとき（ルールを作った・きっかけや状態を変えた）は見た位置を今にするだけで、それより前に過ぎていた会員には当てない
 * - 1 回に当てるのはルールごとに LIMIT 人まで。多ければ次の回に続きから（同じ人に 2 回は rule_hits の主キーで起きない）
 * - 条件の部品があれば、それも満たす会員だけ
 */
import type { SqlDb, SqlStatement, SqlValue } from "../store/sql";
import { listRules } from "../store/rules";
import { MAX_RUNNING_RULES, RUNNING_STATUSES } from "./condition";
import { hasParts, matchSql } from "./evaluate";
import { hitStatements } from "./trigger";
import { isTimeTrigger } from "./triggers";

export const SCAN_LIMIT = 100;

/** ルールごとの「今、きっかけの日数を過ぎている会員」の SQL（customer_id・at（最後か最初の購入）・order_id） */
export function lastOrFirstSql(kind: "last_order" | "first_order", shopId: string): { sql: string; params: SqlValue[] } {
  const agg = kind === "last_order" ? "MAX" : "MIN";
  return {
    sql: `SELECT t.customer_id, t.at,
            (SELECT o.order_id FROM orders o WHERE o.shop_id = ? AND o.customer_id = t.customer_id AND o.cancelled = 0 AND o.ordered_at = t.at ORDER BY o.order_id LIMIT 1) AS order_id
          FROM (SELECT customer_id, ${agg}(ordered_at) AS at FROM orders WHERE shop_id = ? AND cancelled = 0 GROUP BY customer_id) t`,
    params: [shopId, shopId],
  };
}

/**
 * ルールは前に見た位置（scanned_until）の古い順に見る（Cron の上限で途中までしか見られなくても、毎回同じルールが残らないように）。
 * canContinue: ルールを 1 つ始める前に、Cron の上限に収まるかを見る（src/budget.ts）
 */
export async function scanTimeRules(db: SqlDb, shopId: string, now: number, canContinue: () => boolean = () => true): Promise<number> {
  const scans = new Map(
    (await db.all<{ rule_id: string; scanned_until: number }>(`SELECT rule_id, scanned_until FROM rule_scans WHERE shop_id = ?`, [shopId])).map((r) => [r.rule_id, r.scanned_until] as const),
  );
  const rules = (await listRules(db, shopId, RUNNING_STATUSES))
    .filter((r) => isTimeTrigger(r.trigger.kind) && r.trigger.days)
    .slice(0, MAX_RUNNING_RULES)
    // まだ見ていない（動かし始めの）ルールを先に、あとは見た位置の古い順
    .sort((a, b) => (scans.get(a.id) ?? -1) - (scans.get(b.id) ?? -1));
  let hits = 0;
  for (const r of rules) {
    if (!canContinue()) break;
    const until = scans.get(r.id);
    const st = until === undefined ? null : { scanned_until: until };
    if (!st) {
      // 動かし始め: ここから先に日数を過ぎた会員だけに当てる
      await db.run(`INSERT OR IGNORE INTO rule_scans (shop_id, rule_id, scanned_until) VALUES (?, ?, ?)`, [shopId, r.id, now]);
      continue;
    }
    const span = r.trigger.days! * 86400;
    const base = lastOrFirstSql(r.trigger.kind as "last_order" | "first_order", shopId);
    const cond = hasParts(r.condition) ? matchSql(r.condition, { shopId, now }) : null;
    const rows = await db.all<{ customer_id: string; cross_at: number; order_id: string | null }>(
      `SELECT b.customer_id, b.at + ? AS cross_at, b.order_id FROM (${base.sql}) b
       WHERE b.at + ? >= ? AND b.at + ? <= ?${cond ? ` AND b.customer_id IN (${cond.sql})` : ""}
       ORDER BY cross_at, b.customer_id LIMIT ?`,
      [span, ...base.params, span, st.scanned_until, span, now, ...(cond ? cond.params : []), SCAN_LIMIT],
    );
    const statements: SqlStatement[] = [];
    for (const row of rows) statements.push(...(await hitStatements(r, shopId, { customerId: row.customer_id, orderId: row.order_id }, now)));
    // 全部見られたら今まで、上限で切れたら最後に見た時刻から（同じ時刻の人は次の回にもう一度見るが、当たりは重ならない）
    const last = rows[rows.length - 1];
    const next = rows.length < SCAN_LIMIT ? now : last!.cross_at > st.scanned_until ? last!.cross_at : last!.cross_at + 1;
    statements.push({ sql: `UPDATE rule_scans SET scanned_until = ? WHERE shop_id = ? AND rule_id = ?`, params: [next, shopId, r.id] });
    await db.batch(statements);
    hits += rows.length;
  }
  return hits;
}

/** 試しに当てる（時刻のきっかけ）: 今もう日数を過ぎている会員（これからは、ちょうど過ぎた会員に当たる） */
export async function previewTime(
  db: SqlDb,
  kind: "last_order" | "first_order",
  days: number,
  c: import("./condition").Condition,
  shopId: string,
  now: number,
): Promise<{ count: number; sample: string[] }> {
  const base = lastOrFirstSql(kind, shopId);
  const cond = hasParts(c) ? matchSql(c, { shopId, now }) : null;
  const where = `WHERE b.at + ? <= ?${cond ? ` AND b.customer_id IN (${cond.sql})` : ""}`;
  const params: SqlValue[] = [...base.params, days * 86400, now, ...(cond ? cond.params : [])];
  const n = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM (${base.sql}) b ${where}`, params);
  const sample = await db.all<{ customer_id: string }>(`SELECT b.customer_id FROM (${base.sql}) b ${where} ORDER BY b.at DESC LIMIT 10`, params);
  return { count: n?.n ?? 0, sample: sample.map((x) => x.customer_id) };
}
