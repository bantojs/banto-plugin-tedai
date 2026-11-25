import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Actions } from "../src/rules/actions";
import type { Condition } from "../src/rules/condition";
import { explain } from "../src/rules/explain";
import { onOrderPaid } from "../src/rules/trigger";
import { CAP_GIVE_UP_SECONDS, processRuns } from "../src/runs/execute";
import { cancelOrder, recordOrder } from "../src/store/purchases";
import { addSetItems, createSet, getRule, saveRule } from "../src/store/rules";
import { EMPTY_SETTINGS, jstHour, parseSettingsForm, quietUntil, saveSettings } from "../src/store/settings";
import type { Deps } from "../src/deps";
import { BANTO, NOW, SHOP, exchangeRoute, makeDeps, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const CUST = "c0000000-0000-4000-8000-000000000001";
const DAY = 86400;
/** 日本時間のその日の h 時（NOW は 2027-01-15 17:00 JST） */
const jst = (h: number) => NOW - 17 * 3600 + h * 3600;

describe("夜は送らない（日本時間）", () => {
  it("21 時〜9 時: 夜は次の 9 時まで、昼は止めない。始まりと終わりが同じなら止めない", () => {
    const s = { quiet_start: 21, quiet_end: 9 };
    expect(jstHour(NOW)).toBe(17);
    expect(quietUntil(s, jst(12))).toBeNull();
    expect(quietUntil(s, jst(22))).toBe(jst(9) + DAY);
    expect(quietUntil(s, jst(3))).toBe(jst(9));
    expect(quietUntil(s, jst(9))).toBeNull();
    expect(quietUntil({ quiet_start: 0, quiet_end: 6 }, jst(5))).toBe(jst(6));
    expect(quietUntil({ quiet_start: 8, quiet_end: 8 }, jst(8))).toBeNull();
  });
  it("設定の数を確かめる", () => {
    expect(parseSettingsForm({ cap_day: "11" }).errors.join()).toContain("1 日の上限");
    expect(parseSettingsForm({ quiet_start: "24" }).errors.join()).toContain("始まり");
    expect(parseSettingsForm({}).settings).toMatchObject({ cap_day: 1, cap_week: 3, quiet_start: 21, quiet_end: 9 });
  });
});

function banto() {
  const seen: string[] = [];
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.origin !== BANTO || !u.pathname.startsWith("/api/v1/")) return undefined;
    seen.push(`${req.method} ${u.pathname}`);
    if (req.method === "GET" && u.pathname === `/api/v1/customers/${CUST}`) return Response.json({ id: CUST, name: "山田", email: "a@example.com", marketing_consent: false });
    if (u.pathname.endsWith("/line-message")) return Response.json({ id: "l", status: "sent" });
    if (req.method === "PATCH") return Response.json({ ok: true });
    return undefined;
  };
  return { route, seen };
}

const cond = (setId: string): Condition => ({ purchase: { set_id: setId, mode: "distinct_at_least", n: 1, days: null }, orders_at_least: null, spend_at_least: null });
const lineActions = (o: Partial<Actions> = {}): Actions => ({
  attribute: null,
  order_tags: ["t"],
  coupon_id: null,
  message: { channel: "line", line_text: "こんにちは", line_image_url: null, line_button_label: null, line_button_url: null, email_subject: "", email_body: "" },
  notify_slack: false,
  notify_email: false,
  wait_days: 0,
  recheck: true,
  ...o,
});

async function setup(actions: Actions, at = NOW, routes: Route[] = []) {
  const deps = makeDeps([exchangeRoute, ...routes], at);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  const setId = (await createSet(deps.db, SHOP, "セット", at)) as string;
  await addSetItems(deps.db, SHOP, setId, [{ product_id: "A", product_name: "A", product_slug: "a" }], at);
  const ruleId = (await saveRule(deps.db, SHOP, { id: null, name: "r", status: "active", condition: cond(setId), actions }, at)) as string;
  return { deps, setId, ruleId };
}

const order = (id: string, at: number) => ({ order_id: id, customer_id: CUST, total_jpy: 1000, ordered_at: at, cancelled: false, items: [{ product_id: "A", qty: 1, unit_price_jpy: 1000 }], banto_updated_at: null, complete: true });
const at = (deps: Deps, t: number): Deps => ({ ...deps, now: () => t });

describe("待ちと確かめ直し", () => {
  it("n 日後に行い、そのあいだにキャンセルされたら行わない", async () => {
    const b = banto();
    const { deps } = await setup(lineActions({ wait_days: 3 }), NOW, [b.route]);
    await recordOrder(deps.db, SHOP, order("o1", NOW));
    await onOrderPaid(deps.db, SHOP, CUST, "o1", NOW);
    expect((await deps.db.first<{ due_at: number }>(`SELECT due_at FROM runs`))!.due_at).toBe(NOW + 3 * DAY);
    expect(await processRuns(deps, 3)).toBe(0);
    await cancelOrder(deps.db, SHOP, "o1");
    await processRuns(at(deps, NOW + 3 * DAY), 3);
    expect(await deps.db.first(`SELECT status, last_error FROM runs`)).toEqual({ status: "skipped", last_error: "condition_lost" });
    expect(b.seen).toEqual([]);
  });
  it("崩れていなければ、待ったあとに行う", async () => {
    const b = banto();
    const { deps } = await setup(lineActions({ wait_days: 1 }), NOW, [b.route]);
    await recordOrder(deps.db, SHOP, order("o1", NOW));
    await onOrderPaid(deps.db, SHOP, CUST, "o1", NOW);
    await processRuns(at(deps, NOW + DAY), 3);
    expect((await deps.db.first<{ status: string }>(`SELECT status FROM runs`))!.status).toBe("done");
    expect(b.seen).toContain(`POST /api/v1/customers/${CUST}/line-message`);
  });
});

describe("夜とお客様ごとの上限", () => {
  it("夜は連絡のある列を朝まで後ろへずらす（やり直しの回数は増やさない）。連絡の無い列は夜でも行う", async () => {
    const b = banto();
    const night = jst(22);
    const { deps } = await setup(lineActions(), night, [b.route]);
    await recordOrder(deps.db, SHOP, order("o1", night));
    await onOrderPaid(deps.db, SHOP, CUST, "o1", night);
    await processRuns(deps, 3);
    expect(await deps.db.first(`SELECT status, due_at, attempts, last_error FROM runs`)).toEqual({ status: "pending", due_at: jst(9) + DAY, attempts: 0, last_error: "quiet_hours" });
    expect(b.seen).toEqual([]);

    const b2 = banto();
    const r2 = await setup(lineActions({ message: null }), night, [b2.route]);
    await recordOrder(r2.deps.db, SHOP, order("o1", night));
    await onOrderPaid(r2.deps.db, SHOP, CUST, "o1", night);
    await processRuns(r2.deps, 3);
    expect((await r2.deps.db.first<{ status: string }>(`SELECT status FROM runs`))!.status).toBe("done");
  });

  it("上限を超える連絡は空くまでずらし、7 日たっても空かなければ連絡だけ飛ばす", async () => {
    const b = banto();
    const { deps, setId } = await setup(lineActions(), NOW, [b.route]);
    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, cap_day: 1, cap_week: 1 }, NOW);
    // 1 本目のルールで送る
    await recordOrder(deps.db, SHOP, order("o1", NOW));
    await onOrderPaid(deps.db, SHOP, CUST, "o1", NOW);
    await processRuns(deps, 3);
    expect((await deps.db.first<{ message_sent_at: number }>(`SELECT message_sent_at FROM runs`))!.message_sent_at).toBe(NOW);
    // 2 本目のルール（同じ会員）
    const rule2 = (await saveRule(deps.db, SHOP, { id: null, name: "r2", status: "active", condition: { purchase: { set_id: setId, mode: "quantity_at_least", n: 2, days: null }, orders_at_least: null, spend_at_least: null }, actions: lineActions() }, NOW)) as string;
    const t2 = NOW + 3600;
    await recordOrder(deps.db, SHOP, order("o2", t2));
    await onOrderPaid(deps.db, SHOP, CUST, "o2", t2);
    await processRuns(at(deps, t2), 3);
    const second = await deps.db.first<{ status: string; due_at: number; last_error: string }>(`SELECT status, due_at, last_error FROM runs WHERE rule_id = ?`, [rule2]);
    expect(second).toEqual({ status: "pending", due_at: NOW + 7 * DAY + 60, last_error: "customer_cap" });
    // 7 日を過ぎた（作ってから）: 連絡だけ飛ばして、印は付ける
    const giveUp = t2 + CAP_GIVE_UP_SECONDS;
    const before = b.seen.length;
    await deps.db.run(`UPDATE runs SET due_at = ? WHERE rule_id = ?`, [giveUp, rule2]);
    // 1 本目の送った時刻を窓の中に見せるため、送った時刻を後ろへ
    await deps.db.run(`UPDATE runs SET message_sent_at = ? WHERE rule_id <> ?`, [giveUp - 100, rule2]);
    await processRuns(at(deps, giveUp + 10), 3);
    const done = await deps.db.first<{ status: string; steps: string }>(`SELECT status, steps FROM runs WHERE rule_id = ?`, [rule2]);
    expect(done!.status).toBe("done");
    expect(JSON.parse(done!.steps).message).toEqual({ channel: "none", result: "cap" });
    expect(b.seen.slice(before).some((x) => x.endsWith("/line-message"))).toBe(false);
    expect(b.seen.slice(before).some((x) => x.startsWith("PATCH /api/v1/orders/o2"))).toBe(true);
  });
});

describe("会員で確かめる", () => {
  it("記録が無い・もう満たしていた・当たった・まだ、を言い分ける", async () => {
    const { deps, ruleId, setId } = await setup(lineActions(), NOW, [banto().route]);
    const rule = (await getRule(deps.db, SHOP, ruleId))!;
    expect((await explain(deps.db, rule, SHOP, CUST, NOW)).verdict).toContain("手代の記録にありません");
    // ルールを動かす前の購入（当てない）
    await recordOrder(deps.db, SHOP, order("o1", NOW));
    const e1 = await explain(deps.db, rule, SHOP, CUST, NOW);
    expect(e1.matchesNow).toBe(true);
    expect(e1.verdict).toContain("もう満たしていました");
    expect(e1.parts[0]).toMatchObject({ ok: true, have: 1, need: 1, unit: "種類" });
    await onOrderPaid(deps.db, SHOP, CUST, "o1", NOW);
    expect((await explain(deps.db, rule, SHOP, CUST, NOW)).verdict).toContain("もう当たっています");
    // 2 点以上のルール: まだ
    const r2 = (await saveRule(deps.db, SHOP, { id: null, name: "r2", status: "active", condition: { purchase: { set_id: setId, mode: "quantity_at_least", n: 2, days: null }, orders_at_least: null, spend_at_least: null }, actions: lineActions() }, NOW)) as string;
    const e2 = await explain(deps.db, (await getRule(deps.db, SHOP, r2))!, SHOP, CUST, NOW);
    expect(e2.verdict).toContain("次の注文で条件に入れば当たります");
    expect(e2.parts[0]).toMatchObject({ ok: false, have: 1, need: 2, unit: "点" });
  });
});
