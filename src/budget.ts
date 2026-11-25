/**
 * Cron 1 回の呼び出しの上限（Cloudflare Workers）。Cloudflare の説明（2026-11 に確かめた）:
 * - D1 の問い合わせ: 無料プラン 50・有料プラン 1,000（`batch()` は中の文の数によらず 1 回）
 * - 外への通信（subrequest）: 無料プラン 50・有料プラン 10,000。**D1 の呼び出しもここに数える**
 *   （無料プランでは D1 と fetch の合計が 50 まで）
 * 越えるとその回の残りがすべて失敗し、運営者は気づけない（ログに残るだけ）。
 *
 * そこで Cron の中では D1 と fetch を手代が数え、上限の手前で止める（越えずに止めたことを D1 に残せるように）。
 * 仕事は 1 件ごとに、その仕事の見積もり（UNIT_COST）が収まるかを見てから始める。見積もりを越えた仕事は
 * HARD_LIMITS で投げて受け止め、途中の状態を残す書き込みだけは rescue で本当の上限まで許す。
 * 仕事の順番は回ごとに回し、ショップ・ルールは前に見た時刻の古い順に見る（毎回同じ仕事・ショップが後回しにならないように。src/jobs.ts）。
 * 止めたら、その時刻と仕事の名前を残し、手代のホームで「Workers の有料プランに」と知らせる（src/admin/views.tsx）。
 * どのプランかは Worker の変数 WORKERS_PLAN（free 既定 / paid）。
 */
import type { Deps } from "./deps";
import type { SqlDb } from "./store/sql";
import { getKv, setKv } from "./store/settings";

export type WorkersPlan = "free" | "paid";

/** d1 = D1 の問い合わせ、total = D1 と fetch の合計（subrequest） */
export type Limit = { d1: number; total: number };
export type Cost = { d1: number; fetch: number };

/** 本当の上限 */
export const PLATFORM_LIMITS: Record<WorkersPlan, Limit> = {
  free: { d1: 50, total: 50 },
  paid: { d1: 1000, total: 10000 },
};

/** 仕事を始めてよい上限（canContinue がこれを越えそうなら始めない） */
export const LIMITS: Record<WorkersPlan, Limit> = {
  free: { d1: 47, total: 47 },
  paid: { d1: 990, total: 9900 },
};

/**
 * 数えた回数がここに達したら投げる（見積もりを越えた仕事の受け止め）。本当の上限との差は、途中の状態を残す書き込み（rescue、2 回）と、
 * 回の終わりに Cron の状態を残す 1 回の分
 */
export const HARD_LIMITS: Record<WorkersPlan, Limit> = {
  free: { d1: 47, total: 47 },
  paid: { d1: 990, total: 9900 },
};

/**
 * 仕事 1 件で使う回数の見積もり（始める前に、これだけ残っているかを見る）。
 * アクションの列は、ふつうの 1 行（会員を読む・連絡する・終える）で見積もる。クーポンのページ送りなど、まれに多いときは
 * HARD_LIMITS で受け止め、済んだ手順を残して次の回に続ける（src/runs/execute.ts）
 */
export const UNIT_COST = {
  run: { d1: 17, fetch: 4 },
  /** 時刻のきっかけのルール 1 つ（見た位置・当てる会員・当たりの書き込み） */
  timeRule: { d1: 4, fetch: 0 },
  /** 時刻のきっかけを見るショップの始まりと終わり（ルールと見た位置の一覧・続きの位置） */
  timeShop: { d1: 3, fetch: 0 },
  /** お気に入りの商品の在庫・最安値を読む前（お気に入りのルールがあるか・読む商品・トークン） */
  backfillStart: { d1: 3, fetch: 0 },
  /** お気に入りの商品 1 つの在庫・最安値を読んで覚える */
  backfillProduct: { d1: 2, fetch: 1 },
  /** 注文・お気に入りの突き合わせ 1 ページ（取りこぼした注文の読み書きを含む） */
  syncPage: { d1: 8, fetch: 1 },
  prune: { d1: 1, fetch: 0 },
} satisfies Record<string, Cost>;

/** お客様への連絡（アクションの列）に使わせる分。溜まっていても、ほかの仕事（突き合わせ・時刻のきっかけ・片づけ）の分を残す */
export const RUN_SHARE = 0.6;

export class BudgetExceeded extends Error {
  constructor(readonly kind: HitKind) {
    super(`cron budget exceeded: ${kind}`);
    this.name = "BudgetExceeded";
  }
}

/** d1 = D1 の問い合わせ、total = D1 と外への通信の合計 */
export type HitKind = "d1" | "total";

export interface Budget {
  deps: Deps;
  /** 今やっている仕事の名前（止めたときに残す） */
  step: string;
  used(): { d1: number; fetch: number };
  /** 仕事を 1 件始めてよいか（その仕事の見積もりが上限に収まるか）。収まらなければ止めた印を付ける */
  canContinue(cost: Cost): boolean;
  /** 上限の share（0〜1）までに収まるか（止めた印は付けない。1 つの仕事に使わせる分の上限） */
  fits(cost: Cost, share: number): boolean;
  /** 見積もりを越えて投げた後に、途中の状態を残す書き込みだけを本当の上限の 1 つ手前まで許す */
  rescue<T>(fn: () => Promise<T>): Promise<T>;
  /** 上限の手前で止めた */
  stopped(): { kind: HitKind; step: string } | null;
  /** 1 つの仕事に使わせる分（fits の share）で、残りを次の回へ回した（ほかの仕事は続ける。知らせの数には入れる） */
  defer(step: string): void;
  /** 知らせに数える「回しきれなかった」（止めたか、回した） */
  pressure(): { kind: HitKind; step: string } | null;
}

export function createBudget(deps: Deps, plan: WorkersPlan): Budget {
  const limit = LIMITS[plan];
  const hard = HARD_LIMITS[plan];
  const platform = PLATFORM_LIMITS[plan];
  let d1 = 0;
  let fetches = 0;
  let rescuing = false;
  let stopped: { kind: HitKind; step: string } | null = null;
  let deferred: { kind: HitKind; step: string } | null = null;
  const b: Budget = {
    deps,
    step: "",
    used: () => ({ d1, fetch: fetches }),
    canContinue(cost) {
      if (stopped) return false;
      if (d1 + cost.d1 > limit.d1) stopped = { kind: "d1", step: b.step };
      else if (d1 + fetches + cost.d1 + cost.fetch > limit.total) stopped = { kind: "total", step: b.step };
      return !stopped;
    },
    fits(cost, share) {
      return d1 + cost.d1 <= limit.d1 * share && d1 + fetches + cost.d1 + cost.fetch <= limit.total * share;
    },
    async rescue(fn) {
      rescuing = true;
      try {
        return await fn();
      } finally {
        rescuing = false;
      }
    },
    stopped: () => stopped,
    defer(step) {
      deferred ??= { kind: "total", step };
    },
    pressure: () => stopped ?? deferred,
  };
  /** 1 回数える。上限に達していれば投げる（止めたことを残す 1 回の分は、いつも空けておく） */
  const take = (isD1: boolean) => {
    const capD1 = rescuing ? platform.d1 - 1 : hard.d1;
    const capTotal = rescuing ? platform.total - 1 : hard.total;
    if (isD1 && d1 >= capD1) {
      stopped ??= { kind: "d1", step: b.step };
      throw new BudgetExceeded("d1");
    }
    if (d1 + fetches >= capTotal) {
      stopped ??= { kind: "total", step: b.step };
      throw new BudgetExceeded("total");
    }
    if (isD1) d1++;
    else fetches++;
  };
  const db = deps.db;
  const wrapped: SqlDb = {
    all: (sql, params) => (take(true), db.all(sql, params)),
    first: (sql, params) => (take(true), db.first(sql, params)),
    run: (sql, params) => (take(true), db.run(sql, params)),
    batch: (st) => (take(true), db.batch(st)),
  };
  const f = deps.fetch;
  const countedFetch: typeof fetch = (input, init) => {
    try {
      take(false);
    } catch (e) {
      return Promise.reject(e);
    }
    return f(input, init);
  };
  // SMTP の接続（cloudflare:sockets）が外への通信に数えられるかは Cloudflare の説明に無いので、数える側に倒す
  const sockets = deps.sockets;
  b.deps = {
    ...deps,
    db: wrapped,
    fetch: countedFetch,
    ...(sockets ? { sockets: { ...sockets, connect: (...args: Parameters<typeof sockets.connect>) => (take(false), sockets.connect(...args)) } } : {}),
  };
  return b;
}

/** 何回続けて止めたら知らせるか（1 回止めて次の回に回すのはふつうのこと。続くのは、回しても追いつかないとき） */
export const WARN_AFTER_STREAK = 3;

/** Cron の状態（Worker 全体で kv に 1 つ。回の終わりに 1 回だけ書く） */
export const CRON_STATE_KEY = "cron_state";

export interface CronLimitHit {
  at: number;
  kind: HitKind;
  step: string;
  plan: WorkersPlan;
}

export interface CronState {
  /** 回の番号（仕事の順番を回すため） */
  round: number;
  /** 続けて止めた回数 */
  streak: number;
  /** 続けて止めたので知らせた、最後のもの */
  hit: CronLimitHit | null;
}

export function readCronState(raw: string | null): CronState {
  try {
    const v = JSON.parse(raw ?? "{}") as Partial<CronState> & { hit?: Partial<CronLimitHit> & { kind?: string } };
    const h = v.hit;
    const hit: CronLimitHit | null =
      h && typeof h.at === "number" && (h.kind === "d1" || h.kind === "total") ? { at: h.at, kind: h.kind, step: typeof h.step === "string" ? h.step : "", plan: h.plan === "paid" ? "paid" : "free" } : null;
    const int = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0);
    return { round: int(v.round), streak: int(v.streak), hit };
  } catch {
    return { round: 0, streak: 0, hit: null };
  }
}

/** 回の終わりの状態（止めたなら続けた数を 1 つ増やし、WARN_AFTER_STREAK 回に達したら知らせる） */
export function nextCronState(prev: CronState, stopped: { kind: HitKind; step: string } | null, now: number, plan: WorkersPlan): CronState {
  const streak = stopped ? prev.streak + 1 : 0;
  const hit = stopped && streak >= WARN_AFTER_STREAK ? { at: now, kind: stopped.kind, step: stopped.step, plan } : prev.hit;
  return { round: (prev.round + 1) % 1_000_000, streak, hit };
}

export async function lastLimitHit(db: SqlDb): Promise<CronLimitHit | null> {
  return readCronState(await getKv(db, CRON_STATE_KEY)).hit;
}

export async function saveCronState(db: SqlDb, s: CronState): Promise<void> {
  await setKv(db, CRON_STATE_KEY, JSON.stringify(s));
}

/** 変数 WORKERS_PLAN を読む（大文字・前後の空白は気にしない） */
export const parsePlan = (v: unknown): WorkersPlan => (typeof v === "string" && v.trim().toLowerCase() === "paid" ? "paid" : "free");
