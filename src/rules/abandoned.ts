/**
 * カゴ落ちのきっかけ（Banto の checkout.abandoned。会員の予約が払われないまま期限切れになった）。
 * - 会員 × カゴ（予約）で 1 回。条件があれば、それも満たす会員だけ
 * - Banto は期限切れのあとで決済が済むことがあると書いているので、少なくとも 1 時間待ってから、行う直前に
 *   「レジを始めたあと買っていないか」を確かめる（src/runs/execute.ts）
 * - 受け取った時刻を覚える（手代の画面で「届いているか」を出す。受け取る出来事はつないだときに決まるため）
 */
import type { Deps } from "../deps";
import type { Connection } from "../store/connections";
import { listRules } from "../store/rules";
import { setKv } from "../store/settings";
import type { SqlStatement } from "../store/sql";
import { MAX_RUNNING_RULES, RUNNING_STATUSES } from "./condition";
import { hasParts, matchSql } from "./evaluate";
import { hitStatements } from "./trigger";
import { ABANDONED_MIN_DELAY } from "./triggers";

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const lastAbandonedKey = (shopId: string) => `last_abandoned:${shopId}`;

export async function onCheckoutAbandoned(deps: Deps, conn: Connection, d: Record<string, unknown>, envelopeAt: number): Promise<number> {
  const db = deps.db;
  const shopId = conn.shop_id;
  const now = deps.now();
  await setKv(db, lastAbandonedKey(shopId), String(now));
  const customerId = typeof d["customer_id"] === "string" && ID_RE.test(d["customer_id"]) ? d["customer_id"] : null;
  const reservationId = typeof d["reservation_id"] === "string" && ID_RE.test(d["reservation_id"]) ? d["reservation_id"] : null;
  if (!customerId || !reservationId) return 0;
  const startedAt = typeof d["started_at"] === "string" && Number.isFinite(Date.parse(d["started_at"])) ? Math.floor(Date.parse(d["started_at"]) / 1000) : envelopeAt;
  const items = Array.isArray(d["items"]) ? (d["items"] as Record<string, unknown>[]) : [];
  const first = items.map((i) => i["product_id"]).find((p): p is string => typeof p === "string" && ID_RE.test(p)) ?? null;
  const rules = (await listRules(db, shopId, RUNNING_STATUSES)).filter((r) => r.trigger.kind === "checkout_abandoned").slice(0, MAX_RUNNING_RULES);
  const statements: SqlStatement[] = [];
  let hits = 0;
  for (const r of rules) {
    if (hasParts(r.condition)) {
      const m = matchSql(r.condition, { shopId, now, customerId });
      if (!(await db.first<{ ok: number }>(`SELECT EXISTS (SELECT 1 FROM (${m.sql})) AS ok`, m.params))?.ok) continue;
    }
    hits++;
    statements.push(
      ...(await hitStatements(r, shopId, { customerId, orderId: null, productId: first, hitKey: `${customerId}:cart:${reservationId}`, refAt: startedAt, minDelay: ABANDONED_MIN_DELAY }, now)),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return hits;
}
