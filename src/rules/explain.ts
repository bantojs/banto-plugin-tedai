/**
 * 「この会員はこのルールに当たるか・当たらない理由」。手代の購入の記録だけで数える（Banto には聞かない）。
 * 運営者がルールを試すとき・お客様から「届かない」と言われたときの道具。会員 ID で引き、名前などは出さない。
 */
import type { SqlDb, SqlValue } from "../store/sql";
import type { Rule } from "../store/rules";
import { RUNNING_STATUSES, type Condition } from "./condition";
import { isFavoriteTrigger, isTimeTrigger } from "./triggers";

export interface PartResult {
  label: string;
  ok: boolean;
  /** 今の値と、要る値 */
  have: number;
  need: number;
  unit: string;
}

export interface Explanation {
  parts: PartResult[];
  matchesNow: boolean;
  hit: { hit_at: number; order_id: string | null } | null;
  run: { status: string; due_at: number; last_error: string | null; steps: string } | null;
  orders: number;
  verdict: string;
}

const period = (d: number | null) => (d ? `直近 ${d} 日` : "これまで");

async function num(db: SqlDb, sql: string, params: SqlValue[]): Promise<number> {
  return (await db.first<{ n: number | null }>(sql, params))?.n ?? 0;
}

function window(days: number | null, now: number): { sql: string; params: SqlValue[] } {
  return days ? { sql: ` AND o.ordered_at >= ?`, params: [now - days * 86400] } : { sql: "", params: [] };
}

export async function explainParts(db: SqlDb, c: Condition, shopId: string, customerId: string, now: number): Promise<PartResult[]> {
  const out: PartResult[] = [];
  const base = `o.shop_id = ? AND o.customer_id = ? AND o.cancelled = 0`;
  if (c.purchase) {
    const p = c.purchase;
    const w = window(p.days, now);
    const join = `FROM orders o JOIN order_products op ON op.shop_id = o.shop_id AND op.order_id = o.order_id
      JOIN product_set_items si ON si.shop_id = op.shop_id AND si.product_id = op.product_id AND si.set_id = ?`;
    const params: SqlValue[] = [p.set_id, shopId, customerId, ...w.params];
    if (p.mode === "all_in_one_order") {
      const size = await num(db, `SELECT COUNT(*) AS n FROM product_set_items WHERE shop_id = ? AND set_id = ?`, [shopId, p.set_id]);
      const best = await num(db, `SELECT MAX(k) AS n FROM (SELECT COUNT(DISTINCT op.product_id) AS k ${join} WHERE ${base}${w.sql} GROUP BY o.order_id)`, params);
      out.push({ label: `${period(p.days)}の 1 回の注文で、集まりの商品を何種類買ったか（いちばん多い注文）`, ok: size > 0 && best >= size, have: best, need: size, unit: "種類" });
    } else if (p.mode === "distinct_at_least") {
      const have = await num(db, `SELECT COUNT(DISTINCT op.product_id) AS n ${join} WHERE ${base}${w.sql}`, params);
      out.push({ label: `${period(p.days)}に買った集まりの商品の種類`, ok: have >= p.n, have, need: p.n, unit: "種類" });
    } else {
      const have = await num(db, `SELECT SUM(op.qty) AS n ${join} WHERE ${base}${w.sql}`, params);
      out.push({ label: `${period(p.days)}に買った集まりの商品の点数`, ok: have >= p.n, have, need: p.n, unit: "点" });
    }
  }
  if (c.orders_at_least) {
    const w = window(c.orders_at_least.days, now);
    const have = await num(db, `SELECT COUNT(*) AS n FROM orders o WHERE ${base}${w.sql}`, [shopId, customerId, ...w.params]);
    out.push({ label: `${period(c.orders_at_least.days)}の注文の回数`, ok: have >= c.orders_at_least.n, have, need: c.orders_at_least.n, unit: "回" });
  }
  if (c.spend_at_least) {
    const w = window(c.spend_at_least.days, now);
    const have = await num(db, `SELECT SUM(o.total_jpy) AS n FROM orders o WHERE ${base}${w.sql}`, [shopId, customerId, ...w.params]);
    out.push({ label: `${period(c.spend_at_least.days)}の購入額`, ok: have >= c.spend_at_least.yen, have, need: c.spend_at_least.yen, unit: "円" });
  }
  return out;
}

export async function explain(db: SqlDb, rule: Rule, shopId: string, customerId: string, now: number): Promise<Explanation> {
  const parts = await explainParts(db, rule.condition, shopId, customerId, now);
  const time = isTimeTrigger(rule.trigger.kind) && rule.trigger.days ? rule.trigger.days : null;
  if (time) {
    const at = (
      await db.first<{ at: number | null }>(
        `SELECT ${rule.trigger.kind === "last_order" ? "MAX" : "MIN"}(ordered_at) AS at FROM orders WHERE shop_id = ? AND customer_id = ? AND cancelled = 0`,
        [shopId, customerId],
      )
    )?.at;
    const days = at ? Math.floor((now - at) / 86400) : 0;
    parts.unshift({
      label: rule.trigger.kind === "last_order" ? "最後の購入から何日たったか" : "初めての購入から何日たったか",
      ok: !!at && days >= time,
      have: days,
      need: time,
      unit: "日",
    });
  }
  const matchesNow = parts.length > 0 && parts.every((p) => p.ok);
  const hit = await db.first<{ hit_at: number; order_id: string | null }>(`SELECT hit_at, order_id FROM rule_hits WHERE shop_id = ? AND rule_id = ? AND hit_key = ?`, [
    shopId,
    rule.id,
    customerId,
  ]);
  const run = await db.first<{ status: string; due_at: number; last_error: string | null; steps: string }>(
    `SELECT status, due_at, last_error, steps FROM runs WHERE shop_id = ? AND rule_id = ? AND customer_id = ?`,
    [shopId, rule.id, customerId],
  );
  const orders = await num(db, `SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND customer_id = ?`, [shopId, customerId]);
  const running = RUNNING_STATUSES.includes(rule.status);
  let verdict: string;
  if (rule.trigger.kind === "checkout_abandoned") {
    const n = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits WHERE shop_id = ? AND rule_id = ? AND customer_id = ?`, [shopId, rule.id, customerId]))?.n ?? 0;
    verdict =
      `この会員がレジまで進んで払わずに期限が切れたときに当たります（カゴごとに 1 回。これまでに ${n} 回当たっています）。1 時間以上待ってから、そのあと買っていなければ行います。` +
      (parts.length > 0 && !matchesNow ? "ただし、今はほかの条件を満たしていません。" : "");
  } else if (isFavoriteTrigger(rule.trigger.kind)) {
    const favs = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM favorites WHERE shop_id = ? AND customer_id = ?`, [shopId, customerId]))?.n ?? 0;
    const hitsN = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits WHERE shop_id = ? AND rule_id = ? AND customer_id = ?`, [shopId, rule.id, customerId]))?.n ?? 0;
    verdict =
      favs === 0
        ? "この会員のお気に入りは、手代の写しにありません（お気に入りが無い・Banto のモジュール「会員のお気に入り」が OFF）。"
        : `お気に入りの商品が ${favs} 個あります。その商品が${rule.trigger.kind === "favorite_restock" ? "再入荷" : rule.trigger.kind === "favorite_price_drop" ? "値下げ" : "残りわずかに"}したときに当たります（会員 × 商品で 1 回。これまでに ${hitsN} 回当たっています）。` +
          (parts.length > 0 && !matchesNow ? "ただし、今はほかの条件を満たしていません。" : "");
  } else if (orders === 0) verdict = "この会員の注文は、手代の記録にありません（ゲストの注文・つなぐ前で取り込みがまだ・会員 ID の違い・退会のどれか）。";
  else if (hit) verdict = "もう当たっています。同じ会員に同じルールは 1 回だけなので、これからの注文では当たりません。";
  else if (time && matchesNow)
    verdict = `もう ${time} 日を過ぎていますが、当たっていません。当たるのは「ルールが動いているあいだに、ちょうど ${time} 日を過ぎた会員」だけで、この会員はルールを動かし始める前に過ぎていました。`;
  else if (time && running) {
    const tp = parts[0]!;
    verdict = tp.ok
      ? "日数は過ぎていますが、ほかの条件を満たしていません。"
      : `あと ${Math.max(0, tp.need - tp.have)} 日で当たる見込みです${rule.trigger.kind === "last_order" ? "（そのあいだに買わなければ）" : ""}。ほかの条件も、そのときに満たしている必要があります。`;
  } else if (matchesNow)
    verdict =
      "今は条件を満たしていますが、当たっていません。当たるのは「注文でちょうど条件に入ったとき」だけで、この会員はルールを作る前（か、ルールが動いていないとき）にもう満たしていました。次の注文でも「入った」ことにはなりません。";
  else if (!running) verdict = "まだ条件を満たしていません。ルールが「記録だけ」か「動かす」でないので、満たしても当たりません。";
  else verdict = "まだ条件を満たしていません。次の注文で条件に入れば当たります。";
  return { parts, matchesNow, hit: hit ?? null, run: run ?? null, orders, verdict };
}
