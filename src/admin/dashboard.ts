/** ホームに出す数（D1 だけで数える。Banto には聞かない） */
import { revokedSince } from "../store/purge";
import type { Deps } from "../deps";
import { messageSummary, type Steps } from "../runs/execute";
import type { Connection } from "../store/connections";
import { favoriteStats } from "../store/favorites";
import { purchaseStats } from "../store/purchases";
import { getSettings, mailReady } from "../store/settings";
import { syncState } from "../sync";
import type { DashboardData } from "./views";
import { ConnectionRepo } from "../store/connections";
import { loadPeople } from "./people";
import { lastLimitHit } from "../budget";

const WEEK = 7 * 86400;

/** 直近 7 日に Cron が上限の手前で止めたなら、その記録（いまのプランで止めたものだけ。有料プランにした後は前の知らせを出さない） */
async function recentLimitHit(deps: Deps, now: number) {
  const hit = await lastLimitHit(deps.db);
  return hit && hit.at >= now - WEEK && hit.plan === (deps.config.workersPlan ?? "free") ? hit : null;
}

export async function dashboardData(deps: Deps, conn: Connection): Promise<DashboardData> {
  const db = deps.db;
  const shop = conn.shop_id;
  const now = deps.now();
  const n = async (sql: string, params: (string | number)[]) => (await db.first<{ n: number }>(sql, params))?.n ?? 0;
  const statuses = await db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM rules WHERE shop_id = ? GROUP BY status`, [shop]);
  const count = (s: string) => statuses.find((x) => x.status === s)?.n ?? 0;
  const total = statuses.reduce((a, x) => a + x.n, 0);
  const recentRows = await db.all<{ hit_at: number; rule_id: string; rule_name: string; customer_id: string; status: string | null; steps: string | null; updated_at: number | null }>(
    `SELECT h.hit_at, h.rule_id, r.name AS rule_name, h.customer_id, ru.status, ru.steps, ru.updated_at
     FROM rule_hits h JOIN rules r ON r.shop_id = h.shop_id AND r.id = h.rule_id
     LEFT JOIN runs ru ON ru.shop_id = h.shop_id AND ru.rule_id = h.rule_id AND ru.customer_id = h.customer_id
     WHERE h.shop_id = ? ORDER BY COALESCE(ru.updated_at, h.hit_at) DESC LIMIT 10`,
    [shop],
  );
  const settings = await getSettings(db, shop);
  const people = await loadPeople(deps, await new ConnectionRepo(db, deps.config.secret).token(shop), recentRows.map((r) => r.customer_id));
  return {
    people,
    connection: conn,
    now,
    purchases: await purchaseStats(db, shop),
    favorites: await favoriteStats(db, shop),
    sync: await syncState(deps, shop),
    revokedSince: await revokedSince(db, shop),
    rules: { active: count("active"), record_only: count("record_only"), other: total - count("active") - count("record_only") },
    week: {
      hits: await n(`SELECT COUNT(*) AS n FROM rule_hits WHERE shop_id = ? AND hit_at >= ?`, [shop, now - WEEK]),
      sent: await n(`SELECT COUNT(*) AS n FROM runs WHERE shop_id = ? AND message_sent_at >= ?`, [shop, now - WEEK]),
      pending: await n(`SELECT COUNT(*) AS n FROM runs WHERE shop_id = ? AND status = 'pending'`, [shop]),
      failed: await n(`SELECT COUNT(*) AS n FROM runs WHERE shop_id = ? AND status = 'failed' AND updated_at >= ?`, [shop, now - WEEK]),
    },
    recent: recentRows.map((r) => {
      let steps: Steps = {};
      try {
        steps = r.steps ? (JSON.parse(r.steps) as Steps) : {};
      } catch {
        steps = {};
      }
      return {
        at: r.updated_at ?? r.hit_at,
        rule_id: r.rule_id,
        rule_name: r.rule_name,
        customer_id: r.customer_id,
        kind: r.status ? ("run" as const) : ("hit" as const),
        status: r.status ?? "hit",
        summary: messageSummary(steps),
      };
    }),
    setup: { mail: !!deps.config.mail, mailSettings: mailReady(settings), hasRules: total > 0 },
    limitHit: await recentLimitHit(deps, now),
  };
}
