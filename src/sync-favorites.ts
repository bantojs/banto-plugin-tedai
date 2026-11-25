/**
 * お気に入りの取り込み（Cron）。Banto の GET /api/v1/favorites（足した順、0123）を続きから読む。
 * - つないだ直後は、今あるお気に入りを全部（モジュールが OFF のショップは空が返るだけ）
 * - そのあとは取りこぼした favorite.added を拾うため、最後に見た時刻の 5 分前から読み直す（今ある組だけが返るので、外した組は戻らない）
 * - 外したことは hooks の favorite.removed でしか分からない。取りこぼしは、送る直前に Banto で確かめ直して落とす（ルールの版で）
 */
import { BudgetExceeded } from "./budget";
import { BantoError, bantoApi } from "./banto/client";
import type { Deps } from "./deps";
import type { Connection } from "./store/connections";
import { ConnectionRepo } from "./store/connections";
import { favoriteInsert } from "./store/favorites";
import type { SqlStatement } from "./store/sql";

const PAGE = 500;
const OVERLAP_SECONDS = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

interface FavPage {
  items: { customer_id: string; product_id: string; created_at: string }[];
  has_more: boolean;
  cursor: { since: string; after: string } | null;
}

interface Row {
  since: string | null;
  after: string | null;
  caught_up: number;
}

const secs = (s: string) => Math.floor(Date.parse(s) / 1000);

export async function syncFavorites(deps: Deps, connection: Connection, pages: number): Promise<number> {
  const db = deps.db;
  const shopId = connection.shop_id;
  const token = await new ConnectionRepo(db, deps.config.secret).token(shopId);
  if (!token) {
    // 開けない（TEDAI_SECRET が変わった）。誤りを残し、読んだ時刻を進める（ほかのショップの後ろへ回す）
    await db.run(
      `INSERT INTO favorite_sync (shop_id, since, after, caught_up, last_run_at, last_error) VALUES (?, NULL, NULL, 0, ?, 'token_unavailable')
       ON CONFLICT(shop_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
      [shopId, deps.now()],
    );
    return 0;
  }
  let st = (await db.first<Row>(`SELECT since, after, caught_up FROM favorite_sync WHERE shop_id = ?`, [shopId])) ?? { since: null, after: null, caught_up: 0 };
  let read = 0;
  try {
    while (read < pages) {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (st.since) q.set("since", st.since);
      if (st.since && st.after) q.set("after", st.after);
      const page = await bantoApi<FavPage>(deps, token, "GET", `/favorites?${q.toString()}`);
      read++;
      const items = (Array.isArray(page.items) ? page.items : []).filter(
        (f) => typeof f.customer_id === "string" && ID_RE.test(f.customer_id) && typeof f.product_id === "string" && ID_RE.test(f.product_id) && Number.isFinite(Date.parse(f.created_at)),
      );
      const statements: SqlStatement[] = items.map((f) => favoriteInsert(shopId, f.customer_id, f.product_id, secs(f.created_at)));
      const last = items[items.length - 1];
      const done = !page.has_more || !page.cursor;
      const next: Row = done
        ? {
            // 追いついた: 最後に見た時刻の 5 分前から読み直す（読んだものが無ければ同じ所から）。読み始めは前へ戻らない
            since: last ? new Date(Math.max(st.since ? Date.parse(st.since) : 0, (secs(last.created_at) - OVERLAP_SECONDS) * 1000)).toISOString() : st.since,
            after: null,
            caught_up: 1,
          }
        : { since: page.cursor!.since, after: page.cursor!.after, caught_up: st.caught_up };
      statements.push({
        sql: `INSERT INTO favorite_sync (shop_id, since, after, caught_up, last_run_at, last_error) VALUES (?, ?, ?, ?, ?, NULL)
              ON CONFLICT(shop_id) DO UPDATE SET since = excluded.since, after = excluded.after, caught_up = excluded.caught_up,
                last_run_at = excluded.last_run_at, last_error = NULL`,
        params: [shopId, next.since, next.after, next.caught_up, deps.now()],
      });
      await db.batch(statements);
      st = next;
      if (done) break;
    }
  } catch (e) {
    // Cron の上限の手前で止めた（src/budget.ts）。読んだページは書き終えているので、続きは次の回に（誤りとして残さない）
    if (e instanceof BudgetExceeded) throw e;
    const code = e instanceof BantoError ? `${e.status} ${e.code}` : e instanceof Error ? e.message.slice(0, 100) : "unknown";
    await db.run(
      `INSERT INTO favorite_sync (shop_id, since, after, caught_up, last_run_at, last_error) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
      [shopId, st.since, st.after, st.caught_up, deps.now(), code],
    );
    console.error("favorite sync failed", code);
  }
  return read;
}
