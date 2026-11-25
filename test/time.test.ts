import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/admin/session";
import { explain } from "../src/rules/explain";
import { scanTimeRules } from "../src/rules/time-scan";
import { onOrderPaid } from "../src/rules/trigger";
import { processRuns } from "../src/runs/execute";
import { recordOrder } from "../src/store/purchases";
import { addSetItems, createSet, getRule, saveRule } from "../src/store/rules";
import { migrate } from "../src/store/migrations";
import type { Actions } from "../src/rules/actions";
import type { Deps } from "../src/deps";
import { BANTO, ENDPOINT, NOW, SECRET, SHOP, exchangeRoute, makeDeps } from "./helpers";

const DAY = 86400;
const A = "c0000000-0000-4000-8000-00000000000a";
const B = "c0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";
const none = { purchase: null, orders_at_least: null, spend_at_least: null };
const tagOnly = (o: Partial<Actions> = {}): Actions => ({ attribute: null, order_tags: ["t"], coupon_id: null, message: null, notify_slack: false, notify_email: false, wait_days: 0, recheck: true, ...o });
const order = (id: string, customer: string, at: number, product = "A") => ({
  order_id: id,
  customer_id: customer,
  total_jpy: 1000,
  ordered_at: at,
  cancelled: false,
  items: [{ product_id: product, qty: 1, unit_price_jpy: 1000 }],
  banto_updated_at: null,
  complete: true,
});

async function base() {
  const deps = makeDeps();
  await migrate(deps.db);
  return deps;
}
const hits = async (deps: Deps) => (await deps.db.all<{ customer_id: string; order_id: string }>(`SELECT customer_id, order_id FROM rule_hits ORDER BY customer_id`));

describe("最後の購入から n 日", () => {
  it("動かし始めたあとに、ちょうど n 日を過ぎた会員だけに当たる（前に過ぎていた・また買った会員には当たらない）", async () => {
    const deps = await base();
    await recordOrder(deps.db, SHOP, order("oa", A, NOW - 30 * DAY + 3600)); // あと 1 時間で 30 日
    await recordOrder(deps.db, SHOP, order("ob", B, NOW - 40 * DAY)); // もう過ぎている
    await recordOrder(deps.db, SHOP, order("oc1", C, NOW - 30 * DAY + 3600));
    await saveRule(deps.db, SHOP, { id: null, name: "休眠", status: "record_only", condition: none, trigger: { kind: "last_order", days: 30 } }, NOW);
    expect(await scanTimeRules(deps.db, SHOP, NOW)).toBe(0); // 動かし始め
    await recordOrder(deps.db, SHOP, order("oc2", C, NOW + 1800)); // C はまた買った
    await scanTimeRules(deps.db, SHOP, NOW + 2 * 3600);
    expect(await hits(deps)).toEqual([{ customer_id: A, order_id: "oa" }]);
    await scanTimeRules(deps.db, SHOP, NOW + 3 * 3600); // もう一度見ても重ならない
    expect(await hits(deps)).toHaveLength(1);
  });

  it("条件があれば、それも満たす会員だけ。注文のきっかけからは呼ばれない", async () => {
    const deps = await base();
    const setId = (await createSet(deps.db, SHOP, "s", NOW)) as string;
    await addSetItems(deps.db, SHOP, setId, [{ product_id: "A", product_name: "A", product_slug: "a" }], NOW);
    await recordOrder(deps.db, SHOP, order("oa", A, NOW - 30 * DAY + 3600, "A"));
    await recordOrder(deps.db, SHOP, order("ob", B, NOW - 30 * DAY + 3600, "X"));
    await saveRule(deps.db, SHOP, { id: null, name: "A を買った休眠", status: "record_only", condition: { ...none, purchase: { set_id: setId, mode: "distinct_at_least", n: 1, days: null } }, trigger: { kind: "last_order", days: 30 } }, NOW);
    await scanTimeRules(deps.db, SHOP, NOW);
    expect(await onOrderPaid(deps.db, SHOP, A, "oa", NOW)).toEqual([]);
    await scanTimeRules(deps.db, SHOP, NOW + 2 * 3600);
    expect((await hits(deps)).map((h) => h.customer_id)).toEqual([A]);
  });

  it("待っているあいだに買ったら、行わない", async () => {
    const deps = await base();
    await recordOrder(deps.db, SHOP, order("oa", A, NOW - 30 * DAY + 3600));
    await saveRule(deps.db, SHOP, { id: null, name: "休眠", status: "active", condition: none, trigger: { kind: "last_order", days: 30 }, actions: tagOnly({ wait_days: 2 }) }, NOW);
    await scanTimeRules(deps.db, SHOP, NOW);
    await scanTimeRules(deps.db, SHOP, NOW + 2 * 3600);
    await recordOrder(deps.db, SHOP, order("oa2", A, NOW + DAY));
    await processRuns({ ...deps, now: () => NOW + 3 * DAY }, 3);
    expect(await deps.db.first(`SELECT status, last_error FROM runs`)).toEqual({ status: "skipped", last_error: "condition_lost" });
  });

  it("会員で確かめると、あと何日かを出す", async () => {
    const deps = await base();
    await recordOrder(deps.db, SHOP, order("oa", A, NOW - 10 * DAY));
    const id = (await saveRule(deps.db, SHOP, { id: null, name: "休眠", status: "record_only", condition: none, trigger: { kind: "last_order", days: 30 } }, NOW)) as string;
    const e = await explain(deps.db, (await getRule(deps.db, SHOP, id))!, SHOP, A, NOW);
    expect(e.parts[0]).toMatchObject({ have: 10, need: 30, unit: "日", ok: false });
    expect(e.verdict).toContain("あと 20 日");
  });
});

describe("初めての購入から n 日", () => {
  it("最初の注文から数える（あとで買っても当たる）", async () => {
    const deps = await base();
    await recordOrder(deps.db, SHOP, order("o1", A, NOW - 7 * DAY + 600));
    await recordOrder(deps.db, SHOP, order("o2", A, NOW - DAY));
    await saveRule(deps.db, SHOP, { id: null, name: "初回フォロー", status: "record_only", condition: none, trigger: { kind: "first_order", days: 7 } }, NOW);
    await scanTimeRules(deps.db, SHOP, NOW);
    await scanTimeRules(deps.db, SHOP, NOW + 3600);
    expect(await hits(deps)).toEqual([{ customer_id: A, order_id: "o1" }]);
  });
});

describe("画面", () => {
  it("n 日のきっかけは日数が要り、条件は無くても保存できる。試しに当てるは今もう過ぎている人を数える", async () => {
    const app = createApp();
    const ORIGIN = "https://tedai.example.workers.dev";
    const deps = makeDeps([exchangeRoute, (r) => (new URL(r.url).pathname === "/api/v1/coupons" ? Response.json({ items: [] }) : undefined)]);
    await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps);
    await claimOwner(deps.db, SHOP, "u", NOW);
    await recordOrder(deps.db, SHOP, order("ob", B, NOW - 40 * DAY));
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const post = (o: Record<string, string>) => app.fetch(new Request(`${ORIGIN}/admin/rules/save`, { method: "POST", body: new URLSearchParams({ s, name: "休眠", status: "record_only", ...o }), headers: { Origin: ORIGIN } }), deps);
    expect(await (await post({ op: "save", trigger: "last_order" })).text()).toContain("きっかけの日数");
    const pv = await (await post({ op: "preview", trigger: "last_order", trigger_days: "30" })).text();
    expect(pv).toContain("今この条件に当たる会員: 1 人");
    expect(pv).toContain("最後の購入から 30 日たって");
    expect((await post({ op: "save", trigger: "last_order", trigger_days: "30" })).status).toBe(303);
    expect(await deps.db.first(`SELECT trigger, trigger_days FROM rules`)).toEqual({ trigger: "last_order", trigger_days: 30 });
  });
});
