import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/admin/session";
import { enteredBy, preview } from "../src/rules/evaluate";
import type { Condition } from "../src/rules/condition";
import { migrate } from "../src/store/migrations";
import { recordOrder, type OrderIn } from "../src/store/purchases";
import { addSetItems, createSet, saveRule } from "../src/store/rules";
import { syncShop } from "../src/sync";
import { ConnectionRepo } from "../src/store/connections";
import type { Deps } from "../src/deps";
import { BANTO, ENDPOINT, HOOK_SECRET, NOW, SECRET, SHOP, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const DAY = 86400;

const order = (id: string, customer: string, items: [string, number, number?][], at = NOW - DAY, cancelled = false): OrderIn => ({
  order_id: id,
  customer_id: customer,
  total_jpy: items.reduce((a, [, q, u]) => a + q * (u ?? 1000), 0),
  ordered_at: at,
  cancelled,
  items: items.map(([p, qty, u]) => ({ product_id: p, qty, unit_price_jpy: u ?? 1000 })),
  banto_updated_at: null,
  complete: true,
});

async function fixture() {
  const deps = makeDeps();
  await migrate(deps.db);
  const setId = (await createSet(deps.db, SHOP, "秋の 3 点", NOW)) as string;
  await addSetItems(deps.db, SHOP, setId, ["A", "B", "C"].map((p) => ({ product_id: p, product_name: p, product_slug: p.toLowerCase() })), NOW);
  return { deps, setId };
}

const cond = (c: Partial<Condition>): Condition => ({ purchase: null, orders_at_least: null, spend_at_least: null, ...c });

describe("条件の数え方", () => {
  it("1 回の注文で全部・n 種類以上・合計 n 点以上・期間・キャンセルを数え分ける", async () => {
    const { deps, setId } = await fixture();
    const db = deps.db;
    await recordOrder(db, SHOP, order("o1", "u1", [["A", 1], ["B", 1], ["C", 1]])); // 1 回で全部
    await recordOrder(db, SHOP, order("o2", "u2", [["A", 1], ["B", 1]]));
    await recordOrder(db, SHOP, order("o3", "u2", [["C", 2]], NOW - 100 * DAY)); // 別の注文で揃う（100 日前）
    await recordOrder(db, SHOP, order("o4", "u3", [["A", 3], ["X", 1]]));
    await recordOrder(db, SHOP, order("o5", "u4", [["A", 1], ["B", 1], ["C", 1]], NOW - DAY, true)); // キャンセル
    const all = await preview(db, cond({ purchase: { set_id: setId, mode: "all_in_one_order", n: 1, days: null } }), SHOP, NOW);
    expect(all).toEqual({ count: 1, sample: ["u1"] });
    const distinct3 = await preview(db, cond({ purchase: { set_id: setId, mode: "distinct_at_least", n: 3, days: null } }), SHOP, NOW);
    expect(distinct3.sample).toEqual(["u1", "u2"]);
    const distinct3in30 = await preview(db, cond({ purchase: { set_id: setId, mode: "distinct_at_least", n: 3, days: 30 } }), SHOP, NOW);
    expect(distinct3in30.sample).toEqual(["u1"]);
    const qty3 = await preview(db, cond({ purchase: { set_id: setId, mode: "quantity_at_least", n: 3, days: null } }), SHOP, NOW);
    expect(qty3.sample).toEqual(["u1", "u2", "u3"]);
  });
  it("注文の回数・購入額と組み合わせると、すべて満たす人だけ", async () => {
    const { deps, setId } = await fixture();
    const db = deps.db;
    await recordOrder(db, SHOP, order("o1", "u1", [["A", 1, 5000]]));
    await recordOrder(db, SHOP, order("o2", "u1", [["X", 1, 5000]]));
    await recordOrder(db, SHOP, order("o3", "u2", [["A", 1, 20000]]));
    const c = cond({ purchase: { set_id: setId, mode: "distinct_at_least", n: 1, days: null }, orders_at_least: { n: 2, days: null } });
    expect((await preview(db, c, SHOP, NOW)).sample).toEqual(["u1"]);
    const c2 = cond({ spend_at_least: { yen: 10000, days: null } });
    expect((await preview(db, c2, SHOP, NOW)).sample).toEqual(["u1", "u2"]);
    expect((await preview(db, cond({ ...c2, orders_at_least: { n: 2, days: null } }), SHOP, NOW)).sample).toEqual(["u1"]);
  });
  it("条件に入ったのは、その注文で揃ったときだけ", async () => {
    const { deps, setId } = await fixture();
    const db = deps.db;
    const c = cond({ purchase: { set_id: setId, mode: "distinct_at_least", n: 2, days: null } });
    await recordOrder(db, SHOP, order("o1", "u1", [["A", 1]]));
    expect(await enteredBy(db, c, SHOP, "u1", "o1", NOW)).toBe(false);
    await recordOrder(db, SHOP, order("o2", "u1", [["B", 1]]));
    expect(await enteredBy(db, c, SHOP, "u1", "o2", NOW)).toBe(true);
    await recordOrder(db, SHOP, order("o3", "u1", [["C", 1]]));
    expect(await enteredBy(db, c, SHOP, "u1", "o3", NOW)).toBe(false); // もう入っていた
  });
});

async function connected(routes: Route[] = []) {
  const deps = makeDeps([exchangeRoute, ...routes]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  const setId = (await createSet(deps.db, SHOP, "セット", NOW)) as string;
  await addSetItems(deps.db, SHOP, setId, ["A", "B"].map((p) => ({ product_id: p, product_name: p, product_slug: p })), NOW);
  return { deps, setId };
}

let seq = 0;
const paid = async (deps: Deps, orderId: string, customer: string, products: string[]) => {
  const body = JSON.stringify({
    id: `r${++seq}`,
    event: "order.paid",
    created_at: new Date(NOW * 1000).toISOString(),
    shop_id: SHOP,
    attempt: 1,
    data: { order_id: orderId, shop_id: SHOP, total_jpy: 1000, customer_id: customer, items: products.map((p) => ({ sku_id: `s-${p}`, product_id: p, qty: 1, unit_price_jpy: 1000 })) },
  });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};

describe("きっかけ「注文が支払われた」", () => {
  it("記録だけのルールは当たった人を 1 回だけ記録し、下書きは動かない", async () => {
    const { deps, setId } = await connected();
    const c = cond({ purchase: { set_id: setId, mode: "all_in_one_order", n: 1, days: null } });
    const live = (await saveRule(deps.db, SHOP, { id: null, name: "全部", status: "record_only", condition: c }, NOW)) as string;
    await saveRule(deps.db, SHOP, { id: null, name: "下書き", status: "draft", condition: c }, NOW);
    expect((await paid(deps, "o1", "u1", ["A", "B"])).status).toBe(200);
    expect((await paid(deps, "o2", "u1", ["A", "B"])).status).toBe(200);
    expect(await deps.db.all(`SELECT rule_id, customer_id, order_id FROM rule_hits`)).toEqual([{ rule_id: live, customer_id: "u1", order_id: "o1" }]);
  });
  it("明細に商品 ID が無い支払い（古い Banto）は、読み直しで揃ったときに確かめる。つないだ直後の過去の注文では動かさない", async () => {
    let page = 0;
    const pages = [
      { items: [{ id: "old", status: "paid", customer_id: "u9", total_jpy: 1, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z", items: [{ product_id: "A", qty: 1, unit_price_jpy: 1 }, { product_id: "B", qty: 1, unit_price_jpy: 1 }] }], cursor: { updated_since: "2020-01-01T00:00:00Z", after: "old" }, has_more: false },
      { items: [{ id: "o7", status: "paid", customer_id: "u1", total_jpy: 2000, created_at: new Date(NOW * 1000).toISOString(), updated_at: new Date(NOW * 1000).toISOString(), items: [{ product_id: "A", qty: 1, unit_price_jpy: 1000 }, { product_id: "B", qty: 1, unit_price_jpy: 1000 }] }], cursor: { updated_since: new Date(NOW * 1000).toISOString(), after: "o7" }, has_more: false },
    ];
    const { deps, setId } = await connected([(req) => (new URL(req.url).pathname === "/api/v1/orders" ? Response.json(pages[Math.min(page++, 1)]) : undefined)]);
    await saveRule(deps.db, SHOP, { id: null, name: "全部", status: "record_only", condition: cond({ purchase: { set_id: setId, mode: "all_in_one_order", n: 1, days: null } }) }, NOW);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 3); // 過去の注文の取り込み: 当てない
    expect(await deps.db.all(`SELECT * FROM rule_hits`)).toHaveLength(0);
    // 支払いの知らせ（商品 ID なし）→ 読み直しで揃って当たる
    const body = JSON.stringify({ id: "x1", event: "order.paid", created_at: new Date(NOW * 1000).toISOString(), shop_id: SHOP, attempt: 1, data: { order_id: "o7", customer_id: "u1", total_jpy: 2000, items: [{ sku_id: "s1", qty: 1, unit_price_jpy: 1000 }] } });
    await app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
    expect(await deps.db.all(`SELECT * FROM rule_hits`)).toHaveLength(0);
    await syncShop(deps, conn, 3);
    expect(await deps.db.all(`SELECT customer_id, order_id FROM rule_hits`)).toEqual([{ customer_id: "u1", order_id: "o7" }]);
  });
});

describe("管理画面のルール", () => {
  const form = (o: Record<string, string | string[]>) => {
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
    return f;
  };
  const post = (deps: Deps, path: string, body: URLSearchParams, origin = ORIGIN) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin } }), deps);

  it("集まりを作って商品を足し、ルールを試しに当てて保存する", async () => {
    const { deps } = await connected();
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const created = await post(deps, "/admin/sets", form({ s, name: "新作" }));
    expect(created.status).toBe(303);
    const setPath = new URL(created.headers.get("Location")!, ORIGIN).pathname;
    const add = await post(deps, setPath, form({ s, op: "add", product: [JSON.stringify({ id: "A", slug: "a", name: "<b>シャツ</b>" }), "not json"] }));
    expect(add.headers.get("Location")).toContain("msg=added");
    const pageHtml = await (await app.fetch(new Request(`${ORIGIN}${setPath}?s=${encodeURIComponent(s)}`), deps)).text();
    expect(pageHtml).toContain("&lt;b&gt;シャツ&lt;/b&gt;");
    const setId = setPath.split("/").pop()!;
    await recordOrder(deps.db, SHOP, order("o1", "u1", [["A", 1]]));
    const pv = await post(deps, "/admin/rules/save", form({ s, op: "preview", name: "新作を買った", status: "record_only", purchase_on: "1", set_id: setId, mode: "distinct_at_least", n: "1" }));
    expect(pv.status).toBe(200);
    expect(await pv.text()).toContain("今この条件に当たる会員: 1 人");
    expect(await deps.db.all(`SELECT * FROM rules`)).toHaveLength(0);
    const saved = await post(deps, "/admin/rules/save", form({ s, op: "save", name: "新作を買った", status: "record_only", purchase_on: "1", set_id: setId, mode: "distinct_at_least", n: "1" }));
    expect(saved.status).toBe(303);
    expect(await deps.db.all(`SELECT name, status FROM rules`)).toEqual([{ name: "新作を買った", status: "record_only" }]);
    // ルールで使っている集まりは消せない
    const del = await post(deps, setPath, form({ s, op: "delete" }));
    expect(del.headers.get("Location")).toContain("msg=in_use");
  });
  it("条件が無い・券が無い・よそのオリジンは通さない", async () => {
    const { deps } = await connected();
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const r = await post(deps, "/admin/rules/save", form({ s, op: "save", name: "空", status: "draft" }));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("条件を 1 つ以上決めてください");
    expect((await post(deps, "/admin/sets", form({ name: "x" }))).status).toBe(401);
    expect((await post(deps, "/admin/sets", form({ s, name: "x" }), "https://evil.example")).status).toBe(401);
    expect((await app.fetch(new Request(`${ORIGIN}/admin/rules`), deps)).status).toBe(401);
  });
});

describe("画面の参照元の決まり", () => {
  it("Origin が付くよう same-origin にする（no-referrer だとブラウザが POST に Origin: null を付ける）", async () => {
    const deps = makeDeps();
    const res = await app.fetch(new Request(`${ORIGIN}/`), deps);
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(await res.text()).toContain('<meta name="referrer" content="same-origin"/>');
  });
});

describe("画面の CSS", () => {
  it("style の中身をエスケープしない（> の指定が &gt; になると効かない）", async () => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`), makeDeps())).text();
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).toContain("ul.list>li");
    expect(css).not.toContain("&gt;");
  });
});
