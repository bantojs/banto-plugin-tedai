import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { BudgetExceeded, WARN_AFTER_STREAK, createBudget, lastLimitHit, parsePlan, saveCronState } from "../src/budget";
import { runScheduled } from "../src/jobs";
import { signSession } from "../src/admin/session";
import { ConnectionRepo } from "../src/store/connections";
import { ensureMigrated } from "../src/store/migrations";
import { saveRule } from "../src/store/rules";
import type { Deps } from "../src/deps";
import { ENDPOINT, NOW, SECRET, SHOP, makeDeps, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";

/** 何を聞かれても空の一覧を返す Banto（注文・お気に入りの突き合わせが毎回ページを読む） */
const emptyBanto: Route = (req) => (new URL(req.url).pathname.startsWith("/api/v1/") ? Response.json({ items: [], next_cursor: null }) : undefined);

async function shops(deps: Deps, n: number) {
  await ensureMigrated(deps.db);
  const repo = new ConnectionRepo(deps.db, SECRET);
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? SHOP : `shop-${i}`;
    await repo.save({ shop_id: id, endpoint_id: i === 0 ? ENDPOINT : `ep-${i}`, shop_slug: `s${i}`, shop_name: `店 ${i}`, scopes: ["orders:read"], token: "tok", signing_secret: "x".repeat(64), banto_version: "0.10.0", connected_by: null }, NOW);
    await claimOwner(deps.db, id, "u", NOW);
  }
}

/** 元の db・fetch の呼ばれた数を数える（手代の数え方とは別に、本当に越えていないか） */
function counting(deps: Deps) {
  let q = 0;
  let f = 0;
  const db = deps.db;
  const ff = deps.fetch;
  const d: Deps = {
    ...deps,
    db: { all: (s, p) => (q++, db.all(s, p)), first: (s, p) => (q++, db.first(s, p)), run: (s, p) => (q++, db.run(s, p)), batch: (x) => (q++, db.batch(x)) },
    fetch: ((i: RequestInfo | URL, init?: RequestInit) => (f++, ff(i, init))) as typeof fetch,
  };
  return { deps: d, counts: () => ({ q, f }) };
}

describe("Cron の上限", () => {
  it("仕事の見積もりが収まるかを始める前に見る。D1 と fetch の合計も数える", async () => {
    const deps = makeDeps([emptyBanto]);
    await ensureMigrated(deps.db);
    const b = createBudget(deps, "free");
    for (let i = 0; i < 30; i++) await b.deps.db.first(`SELECT 1 AS n`);
    b.step = "runs";
    expect(b.canContinue({ d1: 10, fetch: 5 })).toBe(true);
    for (let i = 0; i < 10; i++) await b.deps.fetch(`${"https://shop.example.com"}/api/v1/x`);
    // D1 30 + fetch 10 = 40。あと 10 の仕事は合計 45 を越える
    expect(b.canContinue({ d1: 5, fetch: 5 })).toBe(false);
    expect(b.stopped()).toEqual({ kind: "total", step: "runs" });
  });

  it("見積もりを越えたら投げ、途中の状態を残す書き込みだけは本当の上限の 1 つ手前まで許す", async () => {
    const deps = makeDeps();
    await ensureMigrated(deps.db);
    const b = createBudget(deps, "free");
    for (let i = 0; i < 47; i++) await b.deps.db.first(`SELECT 1 AS n`);
    expect(() => b.deps.db.first(`SELECT 1 AS n`)).toThrow(BudgetExceeded);
    await b.rescue(async () => {
      await b.deps.db.first(`SELECT 1 AS n`);
      await b.deps.db.first(`SELECT 1 AS n`);
    });
    // 49 回。止めたことを残す 1 回の分は残す
    await expect(b.rescue(() => b.deps.db.first(`SELECT 1 AS n`))).rejects.toThrow(BudgetExceeded);
    expect(b.used().d1).toBe(49);
  });

  it("WORKERS_PLAN は大文字・空白を気にせず読む", () => {
    expect(parsePlan("Paid ")).toBe("paid");
    expect(parsePlan("paid")).toBe("paid");
    expect(parsePlan("")).toBe("free");
    expect(parsePlan(undefined)).toBe("free");
  });

  it("ショップが多くても、回を重ねればどのショップ・どの仕事も進む（毎回同じものが後回しにならない）", async () => {
    const base = makeDeps([emptyBanto]);
    await shops(base, 12);
    let now = NOW;
    const deps = { ...base, now: () => now };
    // お気に入りの取り込みは 1 回 2 ページまでなので、12 ショップは 24 回あれば回り切る
    for (let i = 0; i < 24; i++) {
      const c = counting(deps);
      await runScheduled(c.deps);
      expect(c.counts().q + c.counts().f).toBeLessThanOrEqual(50);
      now += 300;
    }
    const n = async (t: string) => (await base.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    expect(await n("order_sync")).toBe(12);
    expect(await n("favorite_sync")).toBe(12);
  });

  it("無料プランでショップが多くても 1 回の上限（合計 50）を越えず、続けて止めたときだけ知らせる", async () => {
    const base = makeDeps([emptyBanto]);
    await shops(base, 12);
    let now = NOW;
    const deps = { ...base, now: () => now };
    for (let i = 0; i < WARN_AFTER_STREAK; i++) {
      const c = counting(deps);
      await runScheduled(c.deps);
      expect(c.counts().q + c.counts().f).toBeLessThanOrEqual(50);
      if (i < WARN_AFTER_STREAK - 1) expect(await lastLimitHit(base.db)).toBeNull();
      now += 300;
    }
    expect(await lastLimitHit(base.db)).toMatchObject({ at: now - 300, plan: "free" });
  });

  it("ショップが 2 つまでなら知らせない（ルールの無い状態で 1 回 24・40 回。3 つでは上限の手前で止まる）", async () => {
    for (const n of [1, 2]) {
      const base = makeDeps([emptyBanto]);
      await shops(base, n);
      let now = NOW;
      const deps = { ...base, now: () => now };
      for (let i = 0; i < 8; i++) {
        await runScheduled(deps);
        now += 300;
      }
      expect(await lastLimitHit(base.db)).toBeNull();
    }
  });

  it("有料プランなら同じショップの数でも止めない", async () => {
    const base = makeDeps([emptyBanto]);
    base.config.workersPlan = "paid";
    await shops(base, 8);
    let now = NOW;
    for (let i = 0; i < WARN_AFTER_STREAK + 1; i++) {
      await runScheduled({ ...base, now: () => now });
      now += 300;
    }
    expect(await lastLimitHit(base.db)).toBeNull();
  });

  it("ホームで、直近 7 日に止めたことと有料プランへの切り替えを知らせる", async () => {
    const deps = makeDeps([emptyBanto]);
    await shops(deps, 1);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const home = async (d: Deps) => (await app.fetch(new Request(`${ORIGIN}/admin?s=${encodeURIComponent(s)}`), d)).text();
    expect(await home(deps)).not.toContain("WORKERS_PLAN");
    await saveCronState(deps.db, { round: 5, streak: 3, hit: { at: NOW - 3600, kind: "d1", step: "order_sync", plan: "free" } });
    const html = await home(deps);
    expect(html).toContain("Workers の有料プラン");
    expect(html).toContain("WORKERS_PLAN");
    expect(html).toContain("注文の突き合わせ");
    // 7 日より前のことは出さない
    expect(await home({ ...deps, now: () => NOW + 8 * 86400 })).not.toContain("WORKERS_PLAN");
    // 有料プランにした後は、無料プランのときの知らせを出さない
    expect(await home({ ...deps, config: { ...deps.config, workersPlan: "paid" } })).not.toContain("WORKERS_PLAN");
  });

  it("時刻のルールの多いショップがあっても、ほかのショップのルールも見る", async () => {
    const base = makeDeps([emptyBanto]);
    await shops(base, 3);
    const none = { purchase: null, orders_at_least: null, spend_at_least: null };
    const ids = (await base.db.all<{ shop_id: string }>(`SELECT shop_id FROM connections ORDER BY shop_id`)).map((r) => r.shop_id);
    // いちばん先に見られるショップに 20 個、ほかに 1 個ずつ
    for (let i = 0; i < 20; i++) await saveRule(base.db, ids[0]!, { id: null, name: `休眠 ${i}`, status: "record_only", condition: none, trigger: { kind: "last_order", days: 30 + i } }, NOW);
    for (const id of ids.slice(1)) await saveRule(base.db, id, { id: null, name: "休眠", status: "record_only", condition: none, trigger: { kind: "last_order", days: 30 } }, NOW);
    let now = NOW;
    const seen = new Map<string, number>();
    for (let i = 0; i < 12; i++) {
      now += 300;
      await runScheduled({ ...base, now: () => now });
      for (const r of await base.db.all<{ shop_id: string; scanned_until: number }>(`SELECT shop_id, scanned_until FROM rule_scans`)) {
        if (r.scanned_until === now) seen.set(r.shop_id, (seen.get(r.shop_id) ?? 0) + 1);
      }
    }
    for (const id of ids) expect(seen.get(id) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("1 つのショップの思いがけない失敗（トークンが開けない）で、ほかのショップ・ほかの仕事を止めない", async () => {
    const base = makeDeps([emptyBanto]);
    await shops(base, 2);
    await base.db.run(`UPDATE connections SET token_box = 'broken' WHERE shop_id = ?`, [SHOP]);
    let now = NOW;
    for (let i = 0; i < 8; i++) {
      now += 300;
      await expect(runScheduled({ ...base, now: () => now })).resolves.toBeUndefined();
    }
    const n = async (t: string, where = "") => (await base.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} ${where}`))!.n;
    expect(await n("order_sync", "WHERE last_error IS NULL")).toBe(1);
    expect(await n("favorite_sync", "WHERE last_error IS NULL")).toBe(1);
    expect(await n("order_sync", "WHERE last_error = 'token_unavailable'")).toBe(1);
  });

  it("お客様への連絡が溜まっていても、突き合わせ・時刻のきっかけの分を残す", async () => {
    const base = makeDeps([emptyBanto]);
    await shops(base, 1);
    const none = { purchase: null, orders_at_least: null, spend_at_least: null };
    const ruleId = (await saveRule(base.db, SHOP, { id: null, name: "印", status: "active", condition: none, trigger: { kind: "last_order", days: 30 }, actions: { attribute: null, order_tags: ["x"], coupon_id: null, message: null, notify_slack: false, notify_email: false, wait_days: 0, recheck: false } }, NOW)) as string;
    for (let i = 0; i < 30; i++) {
      await base.db.run(`INSERT INTO runs (shop_id, id, rule_id, customer_id, order_id, status, due_at, created_at, updated_at, attempts, steps) VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?, ?, 0, '{}')`, [SHOP, `run${i}`, ruleId, `c${i}`, NOW, NOW, NOW]);
    }
    await runScheduled(base);
    expect(await base.db.first(`SELECT shop_id FROM order_sync`)).not.toBeNull();
  });

  it("お客様への連絡が溜まり続けて毎回次の回へ回すなら、知らせる", async () => {
    const slack: Route = (req) => (req.url.startsWith("https://hooks.slack.com") ? new Response("ok") : undefined);
    const base = makeDeps([emptyBanto, slack]);
    base.config.slackWebhookUrl = "https://hooks.slack.com/services/T000/B000/XXXX";
    await shops(base, 1);
    const none = { purchase: null, orders_at_least: null, spend_at_least: null };
    const ruleId = (await saveRule(base.db, SHOP, { id: null, name: "知らせ", status: "active", condition: none, trigger: { kind: "last_order", days: 30 }, actions: { attribute: null, order_tags: ["x"], coupon_id: null, message: null, notify_slack: true, notify_email: false, wait_days: 0, recheck: true } }, NOW)) as string;
    for (let i = 0; i < 30; i++) {
      await base.db.run(`INSERT INTO runs (shop_id, id, rule_id, customer_id, order_id, status, due_at, created_at, updated_at, attempts, steps) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, '{}')`, [SHOP, `run${i}`, ruleId, `c${i}`, `o${i}`, NOW, NOW, NOW]);
    }
    let now = NOW;
    for (let i = 0; i < WARN_AFTER_STREAK; i++) {
      now += 300;
      await runScheduled({ ...base, now: () => now });
    }
    expect(await lastLimitHit(base.db)).toMatchObject({ step: "runs", plan: "free" });
  });
});
