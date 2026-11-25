import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { runScheduled } from "../src/jobs";
import { syncShop } from "../src/sync";
import { ConnectionRepo } from "../src/store/connections";
import { saveRule } from "../src/store/rules";
import { recordOrder } from "../src/store/purchases";
import { PURGE_CHUNK, PURGE_REVOKED_AFTER_SECONDS, purgeRevokedShop, revokedKey } from "../src/store/purge";
import { recordDelivery } from "../src/store/deliveries";
import { createBudget } from "../src/budget";
import type { Deps } from "../src/deps";
import { BANTO, HOOK_SECRET, NOW, SECRET, SHOP, TOKEN, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const CUST = "c0000000-0000-4000-8000-000000000001";

async function connect(routes: Route[] = []) {
  const deps = makeDeps([exchangeRoute, ...routes]);
  const res = await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps);
  await claimOwner(deps.db, SHOP, "u", NOW);
  expect(res.status).toBe(200);
  return deps;
}

let seq = 0;
async function hook(deps: Deps, event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ id: `d${++seq}`, event, created_at: "2027-01-15T03:00:00Z", shop_id: SHOP, attempt: 1, data });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
}

const paid = (orderId: string, customerId: string | null, items: Record<string, unknown>[]) => ({
  order_id: orderId,
  shop_id: SHOP,
  total_jpy: 9000,
  status: "paid",
  customer_id: customerId,
  items,
});

describe("hooks で購入を記録する", () => {
  it("order.paid の明細を商品ごとに足し合わせ、Banto の API は呼ばない", async () => {
    const deps = await connect();
    const n = deps.calls.length;
    const res = await hook(deps, "order.paid", paid("o1", CUST, [
      { sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 3000 },
      { sku_id: "s2", product_id: "pA", qty: 2, unit_price_jpy: 3000, discount_jpy: 500 },
      { sku_id: "s3", product_id: "pB", qty: 1, unit_price_jpy: 0 },
    ]));
    expect(res.status).toBe(200);
    expect(deps.calls.length).toBe(n);
    const rows = await deps.db.all<{ product_id: string; qty: number; amount_jpy: number }>(`SELECT product_id, qty, amount_jpy FROM order_products ORDER BY product_id`);
    expect(rows).toEqual([
      { product_id: "pA", qty: 3, amount_jpy: 8500 },
      { product_id: "pB", qty: 1, amount_jpy: 0 },
    ]);
    const o = await deps.db.first<{ customer_id: string; ordered_at: number; cancelled: number }>(`SELECT customer_id, ordered_at, cancelled FROM orders`);
    expect(o).toEqual({ customer_id: CUST, ordered_at: Date.parse("2027-01-15T03:00:00Z") / 1000, cancelled: 0 });
  });
  it("ゲストの注文は置かない", async () => {
    const deps = await connect();
    await hook(deps, "order.paid", paid("o2", null, [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 100 }]));
    expect(await deps.db.all(`SELECT * FROM orders`)).toHaveLength(0);
  });
  it("キャンセルで数えないようにし、退会でその会員の記録を消す", async () => {
    const deps = await connect();
    await hook(deps, "order.paid", paid("o1", CUST, [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 100 }]));
    await hook(deps, "order.paid", paid("o2", CUST, [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 100 }]));
    await hook(deps, "order.cancelled", { order_id: "o1", shop_id: SHOP, status: "cancelled" });
    expect(await deps.db.all(`SELECT order_id FROM orders WHERE cancelled = 1`)).toEqual([{ order_id: "o1" }]);
    await hook(deps, "customer.deleted", { customer_id: CUST, shop_id: SHOP });
    expect(await deps.db.all(`SELECT * FROM orders`)).toHaveLength(0);
    expect(await deps.db.all(`SELECT * FROM order_products`)).toHaveLength(0);
  });
});

describe("取りこぼしの読み直し", () => {
  const apiOrder = (id: string, updated: string, status = "paid", customer: string | null = CUST) => ({
    id,
    status,
    customer_id: customer,
    total_jpy: 1000,
    created_at: "2027-01-01T00:00:00Z",
    updated_at: updated,
    items: [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 1000, discount_jpy: 0 }],
  });

  function ordersApi(pages: Record<string, unknown>[]): { route: Route; seen: URL[] } {
    const seen: URL[] = [];
    let i = 0;
    return {
      seen,
      route: (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/api/v1/orders") return undefined;
        expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
        seen.push(u);
        const p = pages[Math.min(i++, pages.length - 1)];
        return new Response(JSON.stringify(p), { headers: { "Content-Type": "application/json" } });
      },
    };
  }

  it("1970 年から続きを読み、追いついたら少し前から読み直す。変わっていない注文は書き直さない", async () => {
    const api = ordersApi([
      { items: [apiOrder("o1", "2027-01-01T00:00:00Z"), apiOrder("g1", "2027-01-01T00:00:01Z", "paid", null)], cursor: { updated_since: "2027-01-01T00:00:01Z", after: "g1" }, has_more: true },
      { items: [apiOrder("o2", "2027-01-02T00:00:00Z", "refunded")], cursor: { updated_since: "2027-01-02T00:00:00Z", after: "o2" }, has_more: false },
      { items: [apiOrder("o2", "2027-01-02T00:00:00Z", "refunded")], cursor: { updated_since: "2027-01-02T00:00:00Z", after: "o2" }, has_more: false },
    ]);
    const deps = await connect([api.route]);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    expect(await syncShop(deps, conn, 5)).toBe(2);
    expect(api.seen[0]!.searchParams.get("updated_since")).toBe("1970-01-01T00:00:00Z");
    expect(api.seen[0]!.searchParams.get("after")).toBeNull();
    expect(api.seen[1]!.searchParams.get("after")).toBe("g1");
    expect(await deps.db.all(`SELECT order_id, cancelled FROM orders ORDER BY order_id`)).toEqual([
      { order_id: "o1", cancelled: 0 },
      { order_id: "o2", cancelled: 1 },
    ]);
    const st = await deps.db.first<{ updated_since: string; caught_up: number }>(`SELECT updated_since, caught_up FROM order_sync`);
    expect(st).toEqual({ updated_since: "2027-01-01T23:55:00.000Z", caught_up: 1 });

    const before = await deps.db.all(`SELECT * FROM order_products`);
    expect(await syncShop(deps, conn, 5)).toBe(1);
    expect(api.seen[2]!.searchParams.get("updated_since")).toBe("2027-01-01T23:55:00.000Z");
    expect(await deps.db.all(`SELECT * FROM order_products`)).toEqual(before);
  });

  it("失敗は記録して、位置は進めない", async () => {
    const deps = await connect([(req) => (new URL(req.url).pathname === "/api/v1/orders" ? new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }) : undefined)]);
    await runScheduled(deps);
    const st = await deps.db.first<{ updated_since: string; last_error: string }>(`SELECT updated_since, last_error FROM order_sync`);
    expect(st).toEqual({ updated_since: "1970-01-01T00:00:00Z", last_error: "401 unauthorized" });
  });

  it("取りこぼした注文にルールを当てる途中で止まっても、残りは次の回に当てる", async () => {
    const recent = new Date((NOW - 600) * 1000).toISOString();
    const order = (i: number) => ({ ...apiOrder(`late${i}`, `2027-01-15T00:00:0${i}Z`, "paid", `c000000${i}-0000-4000-8000-000000000001`), created_at: recent });
    const api = ordersApi([
      { items: [], cursor: null, has_more: false },
      { items: [1, 2, 3, 4, 5].map(order), cursor: { updated_since: "2027-01-15T00:00:05Z", after: "late5" }, has_more: false },
      { items: [], cursor: null, has_more: false },
    ]);
    const deps = await connect([api.route]);
    await saveRule(deps.db, SHOP, { id: null, name: "初めての購入", status: "record_only", condition: { purchase: null, orders_at_least: { n: 1, days: null }, spend_at_least: null } }, NOW - 3600);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 5);
    // 追いついたあとに 5 件の取りこぼし。2 件当てたところで上限
    let allowed = 2;
    await syncShop(deps, conn, 5, () => allowed-- > 0);
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits`))!.n).toBe(2);
    // 次の回（新しい注文は無い）に残りの 3 件
    await syncShop(deps, conn, 5);
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits`))!.n).toBe(5);
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [`late_orders:${SHOP}`])).toBeNull();
  });

  it("hooks でルールを確かめた注文は、読み直しで当て直さない。注文から 1 日を過ぎた残りは捨てる", async () => {
    const recent = new Date((NOW - 600) * 1000).toISOString();
    const api = ordersApi([
      { items: [], cursor: null, has_more: false },
      { items: [{ ...apiOrder("h1", "2027-01-15T00:00:01Z"), created_at: recent }], cursor: { updated_since: "2027-01-15T00:00:01Z", after: "h1" }, has_more: false },
    ]);
    const deps = await connect([api.route]);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 5);
    // hooks で受け取った（明細あり）
    const body = JSON.stringify({ id: "d1", event: "order.paid", created_at: recent, shop_id: SHOP, attempt: 1, data: { order_id: "h1", customer_id: CUST, total_jpy: 1000, items: [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 1000, discount_jpy: 0 }] } });
    await app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
    let asked = 0;
    await syncShop(deps, conn, 5, () => (asked++, true));
    expect(asked).toBe(0);
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [`late_orders:${SHOP}`])).toBeNull();

    // 古い残り（2 日前の注文）は捨てる
    await deps.db.run(`INSERT INTO kv (key, value) VALUES (?, ?)`, [`late_orders:${SHOP}`, JSON.stringify([{ customer_id: CUST, order_id: "old", ordered_at: NOW - 2 * 86400 }])]);
    await syncShop(deps, conn, 5, () => (asked++, true));
    expect(asked).toBe(0);
  });

  it("ルールの多いショップでも、取りこぼした注文は 1 件ずつ当てて一覧から外す（途中で上限に当たっても進む）", async () => {
    const recent = new Date((NOW - 600) * 1000).toISOString();
    const order = (i: number) => ({ ...apiOrder(`m${i}`, `2027-01-15T00:00:0${i}Z`, "paid", `c000000${i}-0000-4000-8000-000000000001`), created_at: recent });
    const api = ordersApi([
      { items: [], cursor: null, has_more: false },
      { items: [1, 2, 3].map(order), cursor: { updated_since: "2027-01-15T00:00:03Z", after: "m3" }, has_more: false },
      { items: [], cursor: null, has_more: false },
    ]);
    const deps = await connect([api.route]);
    for (let r = 0; r < 20; r++) await saveRule(deps.db, SHOP, { id: null, name: `r${r}`, status: "record_only", condition: { purchase: null, orders_at_least: { n: 1, days: null }, spend_at_least: null } }, NOW - 3600);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 5);
    // 1 回に 1 件ずつでも進み、5 回で一覧が空になる（前は当てる途中で上限に当たり、一覧が縮まなかった）
    for (let round = 0; round < 5; round++) {
      const b = createBudget(deps, "free");
      for (let i = 0; i < 20; i++) await b.deps.db.first(`SELECT 1 AS n`);
      await syncShop(b.deps, conn, 5, (cost) => b.canContinue(cost)).catch(() => undefined);
    }
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(DISTINCT customer_id) AS n FROM rule_hits`))!.n).toBe(3);
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [`late_orders:${SHOP}`])).toBeNull();
  });

  it("hooks の「確かめた」印は、ルールを確かめたときだけ。読み直しと hooks が前後しても当たりは 1 回。取り消した注文には当てない", async () => {
    const recent = new Date((NOW - 600) * 1000).toISOString();
    const items = [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 1000, discount_jpy: 0 }];
    const api = ordersApi([
      { items: [], cursor: null, has_more: false },
      { items: [{ ...apiOrder("r1", "2027-01-15T00:00:01Z"), created_at: recent }], cursor: { updated_since: "2027-01-15T00:00:01Z", after: "r1" }, has_more: false },
    ]);
    const deps = await connect([api.route]);
    await saveRule(deps.db, SHOP, { id: null, name: "初めて", status: "record_only", condition: { purchase: null, orders_at_least: { n: 1, days: null }, spend_at_least: null } }, NOW - 3600);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    const hook = async (id: string, event: string, data: Record<string, unknown>) => {
      const body = JSON.stringify({ id, event, created_at: recent, shop_id: SHOP, attempt: 1, data });
      return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
    };
    // 明細に商品 ID の無い支払い（古い Banto）は確かめられないので、印を付けない
    await hook("h0", "order.paid", { order_id: "x0", customer_id: "c9999999-0000-4000-8000-000000000001", total_jpy: 1000, items: [{ sku_id: "s1", qty: 1, unit_price_jpy: 1000, discount_jpy: 0 }] });
    expect((await deps.db.first<{ banto_updated_at: string | null }>(`SELECT banto_updated_at FROM orders WHERE order_id = 'x0'`))!.banto_updated_at).toBeNull();
    // 読み直しが先（一覧に入る）→ hooks（確かめて当てる）→ 読み直しの続き（当て直しても 1 回）
    await syncShop(deps, conn, 5, () => false);
    await syncShop(deps, conn, 5, () => false);
    await hook("h1", "order.paid", { order_id: "r1", customer_id: CUST, total_jpy: 1000, items });
    await syncShop(deps, conn, 5);
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits`))!.n).toBe(1);

    // 一覧に残っているあいだに取り消された注文には当てない
    await deps.db.run(`DELETE FROM rule_hits`);
    await deps.db.run(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [`late_orders:${SHOP}`, JSON.stringify([{ customer_id: CUST, order_id: "r1", ordered_at: NOW - 600 }])]);
    await hook("h2", "order.cancelled", { order_id: "r1" });
    await syncShop(deps, conn, 5);
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM rule_hits`))!.n).toBe(0);
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [`late_orders:${SHOP}`])).toBeNull();
  });

  it("退会した会員の注文は、Banto で更新されて読み直しても記録に戻さない（取りこぼしの一覧からも外す）", async () => {
    const recent = new Date((NOW - 600) * 1000).toISOString();
    const api = ordersApi([
      { items: [], cursor: null, has_more: false },
      { items: [{ ...apiOrder("q1", "2027-01-15T00:00:01Z"), created_at: recent }], cursor: { updated_since: "2027-01-15T00:00:01Z", after: "q1" }, has_more: false },
      // 退会のあと、Banto で発送済みにした（更新時刻が進んだ）
      { items: [{ ...apiOrder("q1", "2027-01-16T00:00:00Z", "shipped"), created_at: recent }], cursor: { updated_since: "2027-01-16T00:00:00Z", after: "q1" }, has_more: false },
    ]);
    const deps = await connect([api.route]);
    await saveRule(deps.db, SHOP, { id: null, name: "初めて", status: "record_only", condition: { purchase: null, orders_at_least: { n: 1, days: null }, spend_at_least: null } }, NOW - 3600);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 5);
    await syncShop(deps, conn, 5, () => false); // 取りこぼしの一覧に入れたまま
    expect(await deps.db.first(`SELECT order_id FROM orders`)).toEqual({ order_id: "q1" });
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [`late_orders:${SHOP}`])).not.toBeNull();
    const body = JSON.stringify({ id: "d9", event: "customer.deleted", created_at: recent, shop_id: SHOP, attempt: 1, data: { customer_id: CUST } });
    await app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
    expect(await deps.db.first(`SELECT order_id FROM orders`)).toBeNull();
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [`late_orders:${SHOP}`])).toBeNull();
    await syncShop(deps, conn, 5);
    expect(await deps.db.first(`SELECT order_id FROM orders`)).toBeNull();
    // 置くのは ID だけ
    expect(await deps.db.all(`SELECT customer_id FROM forgotten_customers`)).toEqual([{ customer_id: CUST }]);
    // 退会の後に遅れて届いた支払いの hooks（再送）でも戻さず、ルールにも当てない
    const late = JSON.stringify({ id: "d10", event: "order.paid", created_at: recent, shop_id: SHOP, attempt: 2, data: { order_id: "q2", customer_id: CUST, total_jpy: 1000, items: [{ sku_id: "s1", product_id: "pA", qty: 1, unit_price_jpy: 1000, discount_jpy: 0 }] } });
    await app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body: late, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, late, NOW) } }), deps);
    expect(await deps.db.first(`SELECT order_id FROM orders`)).toBeNull();
    expect(await deps.db.first(`SELECT rule_id FROM rule_hits`)).toBeNull();
    expect(await deps.db.first(`SELECT id FROM runs`)).toBeNull();
  });

  it("Cron は 1 回に読むページに上限がある", async () => {
    const api = ordersApi([{ items: [], cursor: { updated_since: "2027-01-01T00:00:00Z", after: "x" }, has_more: true }]);
    const deps = await connect([api.route]);
    await runScheduled(deps);
    expect(api.seen.length).toBeLessThanOrEqual(6);
    expect(api.seen.length).toBeGreaterThan(0);
  });

  it("Banto にトークンを断られ続けて 30 日たったショップは、お客様に関わる記録を消す（ルールは残す。読めたら印を外す）", async () => {
    let refuse = true;
    const deps = await connect([(req) => (new URL(req.url).pathname !== "/api/v1/orders" ? undefined : refuse ? new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }) : Response.json({ items: [], cursor: null, has_more: false }))]);
    await saveRule(deps.db, SHOP, { id: null, name: "初めての購入", status: "record_only", condition: { purchase: null, orders_at_least: { n: 1, days: null }, spend_at_least: null } }, NOW);
    await recordOrder(deps.db, SHOP, { order_id: "o1", customer_id: "c1", total_jpy: 1000, ordered_at: NOW, cancelled: false, items: [{ product_id: "A", qty: 1, unit_price_jpy: 1000 }], banto_updated_at: null, complete: true });
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 1);
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toEqual({ value: String(NOW) });
    // もう一度断られても、始まりの時刻は変えない
    await syncShop({ ...deps, now: () => NOW + 100 }, conn, 1);
    expect(await purgeRevokedShop(deps.db, NOW + PURGE_REVOKED_AFTER_SECONDS - 1)).toBeNull();
    expect(await purgeRevokedShop(deps.db, NOW + PURGE_REVOKED_AFTER_SECONDS + 1)).toBe(SHOP);
    expect(await deps.db.all(`SELECT * FROM orders`)).toHaveLength(0);
    expect(await deps.db.all(`SELECT * FROM order_sync`)).toHaveLength(0);
    expect(await deps.db.all(`SELECT * FROM rules`)).toHaveLength(1);
    expect(await deps.db.first(`SELECT key FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toBeNull();
    // 断られて印が付いても、読めたら外す
    await syncShop(deps, conn, 1);
    refuse = false;
    await syncShop(deps, conn, 1);
    expect(await deps.db.first(`SELECT key FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toBeNull();
  });

  it("hooks が届いているあいだ・orders:read を許されていないつなぎ方では、断られても消す印を付けない", async () => {
    const deps = await connect([(req) => (new URL(req.url).pathname === "/api/v1/orders" ? new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }) : undefined)]);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    await syncShop(deps, conn, 1);
    expect(await deps.db.first(`SELECT key FROM kv WHERE key = ?`, [revokedKey(SHOP)])).not.toBeNull();
    // 署名を確かめた hooks が届いた = Banto でつながっている
    await recordDelivery(deps.db, { id: "d-1", shop_id: SHOP, event: "order.paid" }, NOW);
    expect(await deps.db.first(`SELECT key FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toBeNull();
    // orders:read の無いつなぎ方の 401 は、外されたしるしではない
    await syncShop(deps, { ...conn, scopes: ["line:send"] }, 1);
    expect(await deps.db.first(`SELECT key FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toBeNull();
  });

  it("消すのは表ごとに一部ずつで、消し切ってから印を外す。消せなかったショップは後ろへ回す", async () => {
    const deps = await connect();
    const n = PURGE_CHUNK + 5;
    for (let i = 0; i < n; i += 500) {
      await deps.db.batch(Array.from({ length: Math.min(500, n - i) }, (_, j) => ({ sql: `INSERT INTO favorites (shop_id, customer_id, product_id, added_at) VALUES (?, ?, 'p', ?)`, params: [SHOP, `c${i + j}`, NOW] })));
    }
    await deps.db.run(`INSERT INTO kv (key, value) VALUES (?, ?)`, [revokedKey(SHOP), String(NOW - PURGE_REVOKED_AFTER_SECONDS - 10)]);
    expect(await purgeRevokedShop(deps.db, NOW)).toBeNull();
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM favorites`))!.n).toBe(5);
    expect(await purgeRevokedShop(deps.db, NOW)).toBe(SHOP);
    expect((await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM favorites`))!.n).toBe(0);
    expect(await deps.db.first(`SELECT key FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toBeNull();
    // 消すのに失敗したら 1 日後ろへ
    await deps.db.run(`INSERT INTO kv (key, value) VALUES (?, ?)`, [revokedKey(SHOP), String(NOW - PURGE_REVOKED_AFTER_SECONDS - 10)]);
    const failing = { ...deps.db, batch: async () => { throw new Error("d1 timeout"); } };
    await expect(purgeRevokedShop(failing, NOW)).rejects.toThrow("d1 timeout");
    expect(await deps.db.first(`SELECT value FROM kv WHERE key = ?`, [revokedKey(SHOP)])).toEqual({ value: String(NOW - PURGE_REVOKED_AFTER_SECONDS - 10 + 86400) });
  });
});
