import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/admin/session";
import { maskEmail } from "../src/admin/people";
import { onOrderPaid } from "../src/rules/trigger";
import { processRuns } from "../src/runs/execute";
import { recordOrder } from "../src/store/purchases";
import { addSetItems, createSet, saveRule } from "../src/store/rules";
import type { Deps } from "../src/deps";
import { BANTO, ENDPOINT, NOW, SECRET, SHOP, exchangeRoute, makeDeps, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const C1 = "c0000000-0000-4000-8000-000000000001";

const customers: Route = (req) => {
  const u = new URL(req.url);
  if (u.pathname === `/api/v1/customers/${C1}`) return Response.json({ id: C1, name: "山田 花子", email: "hanako@example.com", marketing_consent: false });
  if (u.pathname === "/api/v1/coupons") return Response.json({ items: [] });
  return undefined;
};

async function setup() {
  const deps = makeDeps([exchangeRoute, customers]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
  const setId = (await createSet(deps.db, SHOP, "秋のセット", NOW)) as string;
  await addSetItems(deps.db, SHOP, setId, [{ product_id: "A", product_name: "A", product_slug: "a" }], NOW);
  return { deps, s, setId };
}
const get = (deps: Deps, path: string) => app.fetch(new Request(`${ORIGIN}${path}`), deps);
const post = (deps: Deps, path: string, o: Record<string, string>) => app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: new URLSearchParams(o), headers: { Origin: ORIGIN } }), deps);

describe("入口と期限切れ", () => {
  it("手代の URL を直接開いた画面には目次を出さず、Banto から開くよう案内する", async () => {
    const html = await (await get(makeDeps(), "/")).text();
    expect(html).not.toContain('href="/admin/rules');
    expect(html).toContain("Banto の管理画面から開きます");
  });
  it("期限切れの画面から Banto の管理画面へ戻れる", async () => {
    const html = await (await get(makeDeps(), "/admin/rules?s=x")).text();
    expect(html).toContain(`href="${BANTO}/admin"`);
    expect(html).not.toContain('href="/admin/rules');
  });
});

describe("会員を名前で出す", () => {
  it("メールは頭の 2 文字とドメインだけ", () => {
    expect(maskEmail("hanako@example.com")).toBe("ha***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });
  it("試しに当てるの見本に名前とメールの一部を出す", async () => {
    const { deps, s, setId } = await setup();
    await recordOrder(deps.db, SHOP, { order_id: "o1", customer_id: C1, total_jpy: 1, ordered_at: NOW, cancelled: false, items: [{ product_id: "A", qty: 1, unit_price_jpy: 1 }], banto_updated_at: null, complete: true });
    const html = await (await post(deps, "/admin/rules/save", { s, op: "preview", name: "r", status: "draft", purchase_on: "1", set_id: setId, mode: "distinct_at_least", n: "1" })).text();
    expect(html).toContain("山田 花子");
    expect(html).toContain("ha***@example.com");
    expect(html).not.toContain("hanako@example.com");
  });
});

describe("探す・送った記録", () => {
  it("集まりとルールを名前で絞る", async () => {
    const { deps, s, setId } = await setup();
    await createSet(deps.db, SHOP, "夏のセット", NOW);
    const sets = await (await get(deps, `/admin/sets?s=${encodeURIComponent(s)}&q=${encodeURIComponent("夏")}`)).text();
    expect(sets).toContain("夏のセット");
    expect(sets).not.toContain("秋のセット");
    await saveRule(deps.db, SHOP, { id: null, name: "お礼", status: "draft", condition: { purchase: { set_id: setId, mode: "distinct_at_least", n: 1, days: null }, orders_at_least: null, spend_at_least: null } }, NOW);
    await saveRule(deps.db, SHOP, { id: null, name: "再購入", status: "draft", condition: { purchase: null, orders_at_least: { n: 2, days: null }, spend_at_least: null } }, NOW);
    const rules = await (await get(deps, `/admin/rules?s=${encodeURIComponent(s)}&q=${encodeURIComponent("再")}`)).text();
    expect(rules).toContain("再購入");
    expect(rules).not.toContain(">お礼<");
  });
  it("すべてのルールの送った記録を状態で絞り、名前で出す", async () => {
    const { deps, s, setId } = await setup();
    await saveRule(deps.db, SHOP, { id: null, name: "印だけ", status: "active", condition: { purchase: { set_id: setId, mode: "distinct_at_least", n: 1, days: null }, orders_at_least: null, spend_at_least: null }, actions: { attribute: null, order_tags: ["t"], coupon_id: null, message: null, notify_slack: false, notify_email: false, wait_days: 2, recheck: true } }, NOW);
    await recordOrder(deps.db, SHOP, { order_id: "o1", customer_id: C1, total_jpy: 1, ordered_at: NOW, cancelled: false, items: [{ product_id: "A", qty: 1, unit_price_jpy: 1 }], banto_updated_at: null, complete: true });
    await onOrderPaid(deps.db, SHOP, C1, "o1", NOW);
    await processRuns(deps, 3);
    const all = await (await get(deps, `/admin/runs?s=${encodeURIComponent(s)}&status=pending`)).text();
    expect(all).toContain("印だけ");
    expect(all).toContain("山田 花子");
    const none = await (await get(deps, `/admin/runs?s=${encodeURIComponent(s)}&status=failed`)).text();
    expect(none).toContain("ありません");
  });
});

describe("無言で失敗しない", () => {
  it("何も選ばずに足す・外すと、何も変えていないと知らせる", async () => {
    const { deps, s, setId } = await setup();
    expect((await post(deps, `/admin/sets/${setId}`, { s, op: "add" })).headers.get("Location")).toContain("msg=none_selected");
    expect((await post(deps, `/admin/sets/${setId}`, { s, op: "remove" })).headers.get("Location")).toContain("msg=none_selected");
  });
  it("直すところがあれば、保存ボタンの横にも保存していないと出す", async () => {
    const { deps, s } = await setup();
    const html = await (await post(deps, "/admin/rules/save", { s, op: "save", name: "空", status: "draft" })).text();
    expect(html).toContain("保存していません");
  });
  it("思いがけない失敗は、日本語の画面で知らせる", async () => {
    const { deps, s } = await setup();
    const broken: Deps = { ...deps, db: { ...deps.db, all: async () => { throw new Error("D1_ERROR: network"); } } };
    const res = await get(broken, `/admin/rules?s=${encodeURIComponent(s)}`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("うまく行きませんでした");
  });
});

describe("画面の CSP", () => {
  it("メールの見本を載せる画面だけ、外の https の画像を許す", async () => {
    const { deps, s } = await setup();
    const csp = async (path: string) => (await get(deps, `${path}?s=${encodeURIComponent(s)}`)).headers.get("Content-Security-Policy") ?? "";
    expect(await csp("/admin/rules/new")).toContain("img-src 'self' https:;");
    expect(await csp("/admin/settings")).toContain("img-src 'self';");
    expect(await csp("/admin")).toContain("img-src 'self';");
    const res = await get(deps, `/admin/rules/new?s=${encodeURIComponent(s)}`);
    expect(res.headers.get("X-Tedai-Mail-Preview")).toBeNull();
  });
});
