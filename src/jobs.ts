/**
 * Cron の仕事（5 分ごと）。Workers の無料プランは 1 回の呼び出しで外への fetch 50・D1 のクエリ 50 までなので、
 * 1 回に進める量に予算を持たせ（残りは次の回）、さらに回数を数えて上限の手前で止める（src/budget.ts）。
 */
import type { Deps } from "./deps";
import { ConnectionRepo } from "./store/connections";
import { pruneDeliveries } from "./store/deliveries";
import { ensureMigrated } from "./store/migrations";
import { syncShop } from "./sync";
import { processRuns } from "./runs/execute";
import { scanTimeRules } from "./rules/time-scan";
import { backfillProductStates } from "./rules/favorites";
import { syncFavorites } from "./sync-favorites";
import { BudgetExceeded, CRON_STATE_KEY, RUN_SHARE, UNIT_COST, createBudget, nextCronState, readCronState, saveCronState, type Budget, type CronState } from "./budget";
import { getKv, setKv } from "./store/settings";
import { processNotices } from "./notices/send";
import { pruneNotices } from "./store/notices";
import { purgeRevokedShop } from "./store/purge";

/** Banto にトークンを断られたショップを、もう一度試すまでの間（秒） */
export const REVOKED_RETRY_SECONDS = 6 * 3600;

/** 1 回の Cron で読む注文のページ（90 件）の数。ショップをまたいだ合計 */
export const SYNC_PAGE_BUDGET = 6;
/** お気に入り（500 件）のページの数。ショップをまたいだ合計 */
export const FAVORITE_PAGE_BUDGET = 2;

/**
 * 1 回の Cron で送る取引の知らせの数（1 通で fetch 2 回・D1 2 回、ショップごとに D1 4 回ほど）。
 * ふだんは受け取った直後に送るので、ここは送れなかった分の拾い直しだけ。アクションの列・突き合わせと同じ呼び出しの上限を分け合う
 */
export const NOTICE_BUDGET = 3;
/** 1 回の Cron で知らせに使う D1 の問い合わせの上限（ショップがいくつあっても、ほかの仕事の分を残す） */
export const NOTICE_QUERY_BUDGET = 10;

/** 1 回の Cron で進めるアクションの列の行（1 行で Banto とメール・Slack に 10 回ほど） */
export const RUN_BUDGET = 3;

export async function runScheduled(raw: Deps): Promise<void> {
  // D1 と fetch を数え、上限の手前で止める。止めたらそのことを残し、手代のホームで知らせる（src/budget.ts）
  const plan = raw.config.workersPlan ?? "free";
  const budget = createBudget(raw, plan);
  const deps = budget.deps;
  let state: CronState | null = null;
  try {
    await ensureMigrated(deps.db);
    state = readCronState(await getKv(deps.db, CRON_STATE_KEY));
    await runSteps(deps, budget, state.round);
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
  } finally {
    // 止めた・溜まった連絡を次の回へ回した、のどちらも「回しきれなかった」として数える（続けば知らせる）
    const stopped = budget.pressure();
    if (stopped) console.error("cron budget reached", stopped.kind, stopped.step, JSON.stringify(budget.used()));
    // 回の終わりに 1 回だけ書く（数えない元の db で。上限の手前で止めたときも書けるよう、この 1 回分は空けてある）
    if (state) await saveCronState(raw.db, nextCronState(state, stopped, raw.now(), plan)).catch(() => undefined);
  }
}

type Step = { name: string; run: (deps: Deps, budget: Budget) => Promise<void> };

/** お客様への連絡のあとの仕事。回ごとに始める仕事を 1 つずつずらす（上限で止まっても、毎回同じ仕事が後回しにならないように） */
const STEPS: Step[] = [
  { name: "time_rules", run: timeRules },
  {
    name: "prune",
    run: async (deps, budget) => {
      if (!budget.canContinue({ d1: UNIT_COST.prune.d1 * 5, fetch: 0 })) return;
      await pruneDeliveries(deps.db, deps.now());
      await pruneNotices(deps.db, deps.now());
      // 連携を外されて 30 日たったショップの記録（1 回に 1 つ・表ごとに一部ずつ）
      const purged = await purgeRevokedShop(deps.db, deps.now());
      if (purged) console.log("purged revoked shop data");
    },
  },
  { name: "order_sync", run: orderSync },
  { name: "favorite_sync", run: favoriteSync },
];

async function runSteps(deps: Deps, budget: Budget, round: number): Promise<void> {
  // 注文のお知らせ（受け取ったときに送れなかった分）をいちばん先に。使う D1 は NOTICE_QUERY_BUDGET まで（src/notices/send.ts）
  budget.step = "notices";
  if (budget.canContinue({ d1: NOTICE_QUERY_BUDGET, fetch: NOTICE_BUDGET * 2 })) {
    try {
      await processNotices(deps, NOTICE_BUDGET, { maxQueries: NOTICE_QUERY_BUDGET });
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      console.error("notices failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
  }
  // 待たせているお客様への連絡（1 回 RUN_BUDGET 行まで）
  budget.step = "runs";
  // 溜まっていても使うのは上限の RUN_SHARE まで（ほかの仕事の分を残す。残りの行は次の回に）
  await processRuns(deps, RUN_BUDGET, {
    canContinue: () => {
      // 期限の来た行が残っているのに分を使い切った = 溜まっている（続けば知らせる）
      if (!budget.fits(UNIT_COST.run, RUN_SHARE)) {
        budget.defer("runs");
        return false;
      }
      return budget.canContinue(UNIT_COST.run);
    },
    rescue: budget.rescue,
    stopped: () => budget.stopped() !== null,
  });
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[(round + i) % STEPS.length]!;
    budget.step = step.name;
    // 1 つの仕事の思いがけない失敗で、ほかの仕事まで止めない（順番を回すので、止めると毎回ちがう仕事が巻き込まれる）
    try {
      await step.run(deps, budget);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      console.error("cron step failed", step.name, e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
    if (budget.stopped()) return;
  }
}

/** 時刻のきっかけを見るショップの続きの位置（前の回に最後まで見たショップの次から） */
const TIME_CURSOR_KEY = "time_scan_cursor";

/** 時刻のきっかけ（最後の購入から n 日・初めての購入から n 日）と、お気に入りの商品の在庫・最安値の読み込み */
async function timeRules(deps: Deps, budget: Budget): Promise<void> {
  const ids = (await deps.db.all<{ shop_id: string }>(`SELECT shop_id FROM connections ORDER BY shop_id`)).map((r) => r.shop_id);
  const cursor = await getKv(deps.db, TIME_CURSOR_KEY);
  const start = cursor ? ids.findIndex((id) => id > cursor) : 0;
  const order = start <= 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
  const repo = new ConnectionRepo(deps.db, deps.config.secret);
  for (const shopId of order) {
    // ルールを 1 つも見られないのに続きの位置だけ進めないよう、ショップの始まりとルール 1 つ分を確かめる
    if (!budget.canContinue({ d1: UNIT_COST.timeShop.d1 + UNIT_COST.timeRule.d1, fetch: 0 })) return;
    // 見る前に続きの位置を進める（ルールの多いショップを途中までしか見られなくても、次の回は次のショップから。
    // そのショップの残りのルールは、次に順番が来たときに見た位置の古いものから）
    await setKv(deps.db, TIME_CURSOR_KEY, shopId);
    try {
      await scanTimeRules(deps.db, shopId, deps.now(), () => budget.canContinue(UNIT_COST.timeRule));
      if (budget.stopped()) return;
      // お気に入りの商品の在庫と最安値を、まだ覚えていない分だけ少しずつ
      if (budget.canContinue({ d1: UNIT_COST.backfillStart.d1 + 1, fetch: 0 })) {
        const conn = await repo.get(shopId);
        if (conn) await backfillProductStates(deps, conn, 3, () => budget.canContinue(UNIT_COST.backfillProduct));
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      console.error("time scan failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
    if (budget.stopped()) return;
  }
}

async function orderSync(deps: Deps, budget: Budget): Promise<void> {
  let pages = SYNC_PAGE_BUDGET;
  // 前の回に読まなかったショップから（last_run_at の古い順）
  const shops = await deps.db.all<{ shop_id: string }>(
    // Banto にトークンを断られた（連携を外された・つなぎ直した前のトークン）ショップは、6 時間に 1 回だけ試す（つなぎ直すと印が消える）
    `SELECT c.shop_id FROM connections c LEFT JOIN order_sync s ON s.shop_id = c.shop_id
     WHERE NOT (COALESCE(s.last_error, '') LIKE '401 %' AND s.last_run_at > ?)
     ORDER BY COALESCE(s.last_run_at, 0)`,
    [deps.now() - REVOKED_RETRY_SECONDS],
  );
  const repo = new ConnectionRepo(deps.db, deps.config.secret);
  for (const { shop_id } of shops) {
    const n = Math.min(pages, 3);
    // 見積もりは 1 ページ分（ふつうは 1 ページで追いつく）。続きのページで越えても、読んだページは書き終えているので次の回に続く
    if (pages <= 0 || !budget.canContinue(UNIT_COST.syncPage)) return;
    const c = await repo.get(shop_id);
    if (!c) continue;
    pages -= Math.max(1, await syncShop(deps, c, n, (cost) => budget.canContinue(cost)));
  }
}

async function favoriteSync(deps: Deps, budget: Budget): Promise<void> {
  let pages = FAVORITE_PAGE_BUDGET;
  const favShops = await deps.db.all<{ shop_id: string }>(
    // Banto にトークンを断られた（連携を外された・つなぎ直した前のトークン）ショップは、6 時間に 1 回だけ試す（つなぎ直すと印が消える）
    `SELECT c.shop_id FROM connections c LEFT JOIN favorite_sync s ON s.shop_id = c.shop_id
     WHERE NOT (COALESCE(s.last_error, '') LIKE '401 %' AND s.last_run_at > ?)
     ORDER BY COALESCE(s.last_run_at, 0)`,
    [deps.now() - REVOKED_RETRY_SECONDS],
  );
  const repo = new ConnectionRepo(deps.db, deps.config.secret);
  for (const { shop_id } of favShops) {
    if (pages <= 0 || !budget.canContinue(UNIT_COST.syncPage)) return;
    const c = await repo.get(shop_id);
    if (!c) continue;
    pages -= Math.max(1, await syncFavorites(deps, c, pages));
  }
}
