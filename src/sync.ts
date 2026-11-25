/**
 * 取りこぼしの読み直しと、つないだ直後の過去の注文の取り込み（Cron）。
 * Banto の GET /api/v1/orders?updated_since=&after=（0105）で、更新の古い順に続きから読む。
 * - 初めは 1970 年から（過去の注文を全部）。1 回に読む量は予算まで、残りは次の回
 * - 追いついたら、書き込みの取引が終わる前の時刻が付く注文を拾うため、最後の時刻の少し前から読み直す
 * - 変わっていない注文は書き直さない（D1 の書き込みの行数を使わない）
 */
import { clearRevoked, markRevoked } from "./store/purge";
import { BudgetExceeded } from "./budget";
import { BantoError, bantoApi } from "./banto/client";
import type { Deps } from "./deps";
import { ConnectionRepo, type Connection } from "./store/connections";
import { orderPaidRules, orderPaidStatements } from "./rules/trigger";
import { forgottenAmong, orderStatements, parseOrder } from "./store/purchases";
import type { SqlStatement } from "./store/sql";
import { getKv } from "./store/settings";

// D1 は 1 つのクエリにバインドできる値が 100 個まで（注文の ID の IN とショップの ID で 1 ページの件数 + 1 個）
const PAGE = 90;
const OVERLAP_SECONDS = 300;
const EPOCH = "1970-01-01T00:00:00Z";
/** 取りこぼした支払いとしてルールを確かめるのは、追いついたあとに初めて見た 1 日以内の注文だけ（つないだ直後の過去の注文では動かさない） */
const LATE_TRIGGER_SECONDS = 86400;
/** 1 回の読み直しで確かめる注文の数（D1 のクエリの数に収める） */
const LATE_TRIGGER_MAX = 5;

interface ApiOrder {
  id: string;
  status: string;
  customer_id: string | null;
  total_jpy: number;
  created_at: string;
  updated_at: string;
  items: unknown[];
}

interface OrdersPage {
  items: ApiOrder[];
  cursor: { updated_since: string; after: string } | null;
  has_more: boolean;
}

interface SyncRow {
  shop_id: string;
  updated_since: string;
  after: string | null;
  caught_up: number;
}

const secs = (s: string) => Math.floor(Date.parse(s) / 1000);

/** 取りこぼした注文のうち、まだルールを当てていないもの（kv にショップごと。ページの書き込みと同じ取引で残す） */
const lateKey = (shopId: string) => `late_orders:${shopId}`;
/** 残しておく数の上限（Cron の上限で当てるのが遅れても増え続けないように） */
const LATE_KEEP = 50;

type Late = { customer_id: string; order_id: string; ordered_at: number };

/** 残した注文を読む。注文から LATE_TRIGGER_SECONDS を過ぎたものは捨てる（何日も後に「ご注文ありがとう」を送らない） */
const readLate = (raw: string | null, now: number): Late[] => {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is Late => !!x && typeof x.customer_id === "string" && typeof x.order_id === "string" && typeof x.ordered_at === "number" && x.ordered_at >= now - LATE_TRIGGER_SECONDS)
      : [];
  } catch {
    return [];
  }
};

const lateWrite = (shopId: string, late: Late[]): SqlStatement =>
  late.length > 0
    ? { sql: `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, params: [lateKey(shopId), JSON.stringify(late)] }
    : { sql: `DELETE FROM kv WHERE key = ?`, params: [lateKey(shopId)] };

/**
 * 1 ショップを pages 回まで読み進める。読んだページ数を返す。
 * canContinue: 取りこぼした注文にルールを当てる前に、Cron の上限に収まるかを見る（src/budget.ts）。
 * 当てていない注文はページと同じ取引で kv に残してから当てるので、上限で止まっても次の回に続きから当てる（当たりは主キーで重ならない）
 */
export async function syncShop(deps: Deps, connection: Connection, pages: number, canContinue: (cost: { d1: number; fetch: number }) => boolean = () => true): Promise<number> {
  const db = deps.db;
  const shopId = connection.shop_id;
  const token = await new ConnectionRepo(db, deps.config.secret).token(shopId);
  if (!token) {
    // 開けない（TEDAI_SECRET が変わった）。誤りを残し、読んだ時刻を進める（ほかのショップの後ろへ回す）
    await db.run(
      `INSERT INTO order_sync (shop_id, updated_since, after, caught_up, last_run_at, last_error) VALUES (?, ?, NULL, 0, ?, 'token_unavailable')
       ON CONFLICT(shop_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
      [shopId, EPOCH, deps.now()],
    );
    return 0;
  }
  let st = (await db.first<SyncRow>(`SELECT shop_id, updated_since, after, caught_up FROM order_sync WHERE shop_id = ?`, [shopId])) ?? {
    shop_id: shopId,
    updated_since: EPOCH,
    after: null,
    caught_up: 0,
  };
  let read = 0;
  let late = readLate(await getKv(db, lateKey(shopId)), deps.now());
  /** 残した注文に 1 件ずつルールを当てる（LATE_TRIGGER_MAX 件まで）。当たりと一覧から外す書き込みは同じ取引で */
  async function triggerLate() {
    if (late.length === 0) return;
    const rules = await orderPaidRules(db, shopId);
    if (rules.length === 0) {
      // 当てるルールが無い: 一覧をまとめて消す
      late = [];
      await db.run(`DELETE FROM kv WHERE key = ?`, [lateKey(shopId)]);
      return;
    }
    // D1 は 1 件でルールの数 + 1
    for (let i = 0; i < LATE_TRIGGER_MAX && late.length > 0; i++) {
      if (!canContinue({ d1: rules.length + 1, fetch: 0 })) break;
      const o = late[0]!;
      const { statements } = await orderPaidStatements(db, rules, shopId, o.customer_id, o.order_id, deps.now());
      late = late.slice(1);
      await db.batch([...statements, lateWrite(shopId, late)]);
    }
  }

  try {
    // 前の回までに残した注文から当てる（ページを読む前に。読んだ後では、ルールの多いショップで当てる分の回数が残らないことがある）
    await triggerLate();
    for (; read < pages; ) {
      const q = new URLSearchParams({ updated_since: st.updated_since, limit: String(PAGE) });
      if (st.after) q.set("after", st.after);
      const page = await bantoApi<OrdersPage>(deps, token, "GET", `/orders?${q.toString()}`);
      read++;
      const items = Array.isArray(page.items) ? page.items : [];
      const statements: SqlStatement[] = [];
      const lateBefore = late.length;
      if (items.length > 0) {
        const ids = items.map((o) => o.id).filter((id) => typeof id === "string");
        const known = new Map(
          (
            await db.all<{ order_id: string; banto_updated_at: string | null }>(
              `SELECT order_id, banto_updated_at FROM orders WHERE shop_id = ? AND order_id IN (${ids.map(() => "?").join(",")})`,
              [shopId, ...ids],
            )
          ).map((r) => [r.order_id, r.banto_updated_at]),
        );
        // 退会した会員の注文は記録に戻さない（Banto は退会した会員の注文を残す）
        const forgotten = await forgottenAmong(db, shopId, items.map((o) => o.customer_id).filter((x): x is string => typeof x === "string"));
        for (const o of items) {
          const prev = known.get(o.id);
          if (prev === o.updated_at) continue;
          if (typeof o.customer_id === "string" && forgotten.has(o.customer_id)) continue;
          const parsed = parseOrder(o as unknown as Record<string, unknown>, {
            orderedAt: secs(o.created_at) || deps.now(),
            cancelled: o.status === "cancelled" || o.status === "refunded",
            bantoUpdatedAt: o.updated_at,
          });
          if (!parsed) continue;
          statements.push(...orderStatements(shopId, parsed));
          // 初めて見た（hooks を取りこぼした）か、hooks では明細が足りなかった（商品 ID の無い古い Banto）支払い
          const firstFullView = prev === undefined || prev === null;
          if (st.caught_up && firstFullView && !parsed.cancelled && parsed.ordered_at >= deps.now() - LATE_TRIGGER_SECONDS && parsed.customer_id) {
            if (!late.some((x) => x.order_id === parsed.order_id)) late.push({ customer_id: parsed.customer_id, order_id: parsed.order_id, ordered_at: parsed.ordered_at });
          }
        }
      }
      const done = !page.has_more || !page.cursor;
      const next: SyncRow = done
        ? {
            shop_id: shopId,
            // 追いついた: 最後に見た注文の時刻の少し前から、次の回に読み直す（読んだ注文が無ければ同じ所から）。
            // 最後に見た時刻は前の回より後なので、読み始めは前へ戻らない
            updated_since: page.cursor ? new Date(Math.max(0, secs(page.cursor.updated_since) - OVERLAP_SECONDS) * 1000).toISOString() : st.updated_since,
            after: null,
            caught_up: 1,
          }
        : { shop_id: shopId, updated_since: page.cursor!.updated_since, after: page.cursor!.after, caught_up: st.caught_up };
      if (late.length > lateBefore) {
        if (late.length > LATE_KEEP) console.error("late orders over keep", late.length - LATE_KEEP);
        late = late.slice(-LATE_KEEP);
        statements.push(lateWrite(shopId, late));
      }
      statements.push({
        sql: `INSERT INTO order_sync (shop_id, updated_since, after, caught_up, last_run_at, last_error) VALUES (?, ?, ?, ?, ?, NULL)
              ON CONFLICT(shop_id) DO UPDATE SET updated_since = excluded.updated_since, after = excluded.after, caught_up = excluded.caught_up,
                last_run_at = excluded.last_run_at, last_error = NULL`,
        params: [shopId, next.updated_since, next.after, next.caught_up, deps.now()],
      });
      // 読めた: 断られ続けた印を外す（src/store/purge.ts）
      statements.push(clearRevoked(shopId));
      await db.batch(statements);
      st = next;
      if (done) break;
    }
    // このページで見つけた取りこぼしも、回数が残っていれば今のうちに
    await triggerLate();
  } catch (e) {
    // Cron の上限の手前で止めた（src/budget.ts）。読んだページと、まだ当てていない注文は書き終えているので、続きは次の回に（誤りとして残さない）
    if (e instanceof BudgetExceeded) throw e;
    const code = e instanceof BantoError ? `${e.status} ${e.code}` : e instanceof Error ? e.message.slice(0, 100) : "unknown";
    await db.batch([
      {
        sql: `INSERT INTO order_sync (shop_id, updated_since, after, caught_up, last_run_at, last_error) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
        params: [shopId, st.updated_since, st.after, st.caught_up, deps.now(), code],
      },
      // トークンを断られた（連携を外された）: 続いたら、お客様に関わる記録を消す（src/store/purge.ts）
      // （orders:read を許されていないつなぎ方の 401 は、外されたしるしではない）
      ...(e instanceof BantoError && e.status === 401 && connection.scopes.includes("orders:read") ? [markRevoked(shopId, deps.now())] : []),
    ]);
    console.error("order sync failed", code);
  }
  return read;
}

export async function syncState(deps: Deps, shopId: string): Promise<{ caught_up: boolean; last_run_at: number | null; last_error: string | null } | null> {
  const r = await deps.db.first<{ caught_up: number; last_run_at: number | null; last_error: string | null }>(
    `SELECT caught_up, last_run_at, last_error FROM order_sync WHERE shop_id = ?`,
    [shopId],
  );
  return r ? { caught_up: r.caught_up === 1, last_run_at: r.last_run_at, last_error: r.last_error } : null;
}
