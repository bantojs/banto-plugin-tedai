import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { parseActionsForm, type Actions } from "../src/rules/actions";
import { backfillProductStates } from "../src/rules/favorites";
import { processRuns } from "../src/runs/execute";
import { addFavorite } from "../src/store/favorites";
import { ConnectionRepo } from "../src/store/connections";
import { recordOrder } from "../src/store/purchases";
import { saveRule } from "../src/store/rules";
import type { TriggerKind } from "../src/rules/triggers";
import type { Deps } from "../src/deps";
import { BANTO, HOOK_SECRET, NOW, SECRET, SHOP, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const A = "c0000000-0000-4000-8000-00000000000a";
const B = "c0000000-0000-4000-8000-00000000000b";
const none = { purchase: null, orders_at_least: null, spend_at_least: null };

/** 偽の Banto: 商品の在庫と値段を変えられる */
function banto() {
  const state = { available: 0, price: 5000, published: true, favorites: new Set(["P1"]) };
  const seen: { method: string; path: string; body: unknown }[] = [];
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.origin !== BANTO || !u.pathname.startsWith("/api/v1/")) return undefined;
    const body = req.method === "GET" ? null : await req.clone().json().catch(() => null);
    seen.push({ method: req.method, path: u.pathname, body });
    if (u.pathname === "/api/v1/products/P1")
      return Response.json({ id: "P1", slug: "linen-shirt", name: "リネンシャツ", published: state.published, skus: [{ id: "s1", price_jpy: state.price, available: state.available }, { id: "s2", price_jpy: state.price + 500, available: 0 }] });
    if (u.pathname === `/api/v1/customers/${A}/favorites`) return Response.json({ items: [...state.favorites].map((p) => ({ customer_id: A, product_id: p })) });
    if (u.pathname === `/api/v1/customers/${B}/favorites`) return Response.json({ items: [] });
    if (u.pathname === `/api/v1/customers/${A}`) return Response.json({ id: A, name: "山田 花子", email: "a@example.com", marketing_consent: false });
    if (u.pathname.endsWith("/line-message")) return Response.json({ id: "l", status: "sent" });
    return undefined;
  };
  return { state, seen, route };
}

const lineActions = (text: string): Actions => ({
  attribute: null,
  order_tags: [],
  coupon_id: null,
  message: { channel: "line", line_text: text, line_image_url: null, line_button_label: null, line_button_url: null, email_subject: "", email_body: "" },
  notify_slack: false,
  notify_email: false,
  wait_days: 0,
  recheck: true,
});

async function setup(kind: TriggerKind, b: ReturnType<typeof banto>, status: "active" | "record_only" = "record_only", actions?: Actions) {
  const deps = makeDeps([exchangeRoute, b.route]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await addFavorite(deps.db, SHOP, A, "P1", NOW - 100);
  await addFavorite(deps.db, SHOP, B, "P1", NOW - 50);
  await saveRule(deps.db, SHOP, { id: null, name: "お気に入り", status, condition: none, trigger: { kind, days: null, excludeBought: true }, actions }, NOW);
  return deps;
}

let seq = 0;
const hook = async (deps: Deps, event: string, data: Record<string, unknown>) => {
  const body = JSON.stringify({ id: `fv${++seq}`, event, created_at: "2027-01-15T08:00:00Z", shop_id: SHOP, attempt: 1, data: { shop_id: SHOP, ...data } });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};
const hits = (deps: Deps) => deps.db.all<{ customer_id: string; product_id: string }>(`SELECT customer_id, product_id FROM rule_hits ORDER BY customer_id`);

describe("お気に入りの商品が再入荷した", () => {
  it("初めて見たときは覚えるだけ。在庫がゼロからありになったら、入れている会員に当てる（もう買った会員は除く）", async () => {
    const b = banto();
    const deps = await setup("favorite_restock", b);
    await recordOrder(deps.db, SHOP, { order_id: "ob", customer_id: B, total_jpy: 1, ordered_at: NOW - 10, cancelled: false, items: [{ product_id: "P1", qty: 1, unit_price_jpy: 1 }], banto_updated_at: null, complete: true });
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(await hits(deps)).toEqual([]);
    expect(await deps.db.first(`SELECT available, min_price FROM product_state`)).toEqual({ available: 0, min_price: 5000 });
    b.state.available = 3;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(await hits(deps)).toEqual([{ customer_id: A, product_id: "P1" }]);
    // もう一度在庫が増えても、同じ会員 × 商品には 1 回
    b.state.available = 0;
    await hook(deps, "product.updated", { product_id: "P1" });
    b.state.available = 5;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(await hits(deps)).toHaveLength(1);
  });

  it("覚えていない商品は Cron で読んでおく", async () => {
    const b = banto();
    const deps = await setup("favorite_restock", b);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    expect(await backfillProductStates(deps, conn, 3)).toBe(1);
    b.state.available = 2;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect((await hits(deps)).map((h) => h.customer_id)).toEqual([A, B]);
  });
});

describe("値下げ・残りわずか", () => {
  it("いちばん安い SKU の値段が下がったら当てる", async () => {
    const b = banto();
    const deps = await setup("favorite_price_drop", b);
    await hook(deps, "product.updated", { product_id: "P1" });
    b.state.price = 4000;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect((await hits(deps)).map((h) => h.customer_id)).toEqual([A, B]);
  });
  it("在庫僅少の知らせ（在庫がまだある分だけ）で当てる", async () => {
    const b = banto();
    const deps = await setup("favorite_low_stock", b);
    await hook(deps, "inventory.low", { sku_id: "s1", product_id: "P1", available: 0, threshold: 3 });
    expect(await hits(deps)).toEqual([]);
    await hook(deps, "inventory.low", { sku_id: "s1", product_id: "P1", available: 2, threshold: 3 });
    expect((await hits(deps)).map((h) => h.customer_id)).toEqual([A, B]);
  });
  it("お気に入りのルールが無いショップでは、product.updated を読まず D1 にも書かない", async () => {
    const b = banto();
    const deps = await setup("favorite_restock", b);
    await deps.db.run(`UPDATE rules SET status = 'draft'`);
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(b.seen).toHaveLength(0);
    expect(await deps.db.all(`SELECT * FROM hook_deliveries`)).toHaveLength(0);
  });
});

describe("お気に入りのアクション", () => {
  it("商品の名前と URL を差し込み、外していたら送らない", async () => {
    const b = banto();
    const deps = await setup("favorite_restock", b, "active", lineActions("{{name}} さん、{{product_name}} が再入荷しました {{product_url}}"));
    await hook(deps, "product.updated", { product_id: "P1" });
    b.state.available = 3;
    await hook(deps, "product.updated", { product_id: "P1" });
    // B はお気に入りを外していた（Banto の今のお気に入りに無い）
    await processRuns(deps, 5);
    const line = b.seen.filter((x) => x.path.endsWith("/line-message"));
    expect(line).toHaveLength(1);
    expect(line[0]!.body).toEqual({ text: `山田 花子 さん、リネンシャツ が再入荷しました ${BANTO}/my-shop/products/linen-shirt` });
    expect(await deps.db.all(`SELECT customer_id, status, last_error FROM runs ORDER BY customer_id`)).toEqual([
      { customer_id: A, status: "done", last_error: null },
      { customer_id: B, status: "skipped", last_error: "favorite_removed" },
    ]);
  });
  it("売り切れていたら送らない", async () => {
    const b = banto();
    const deps = await setup("favorite_restock", b, "active", lineActions("{{product_name}}"));
    await hook(deps, "product.updated", { product_id: "P1" });
    b.state.available = 3;
    await hook(deps, "product.updated", { product_id: "P1" });
    b.state.available = 0;
    await processRuns(deps, 5);
    expect((await deps.db.all<{ last_error: string }>(`SELECT last_error FROM runs`)).map((r) => r.last_error)).toEqual(["sold_out", "sold_out"]);
  });
  it("商品の差し込みは、お気に入りのきっかけのときだけ", () => {
    const f = { message_on: "1", channel: "line", line_text: "{{product_name}}" };
    const ctx = { mailTransport: true, mailSettings: true, operatorEmail: true, slack: true };
    expect(parseActionsForm(f, ctx).errors.join()).toContain("お気に入りの商品かカゴ落ちのときだけ");
    expect(parseActionsForm(f, { ...ctx, productTrigger: true }).errors).toEqual([]);
  });
});

describe("「もう買った会員は除く」の表示", () => {
  it("OFF で保存したルールを開き直すと OFF のまま（新規は ON、試しに当てたあとも送った値のまま）", async () => {
    const { signSession } = await import("../src/admin/session");
    const { ENDPOINT } = await import("./helpers");
    const b = banto();
    const deps = makeDeps([exchangeRoute, b.route, (r) => (new URL(r.url).pathname === "/api/v1/coupons" ? Response.json({ items: [] }) : undefined)]);
    await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps);
    await claimOwner(deps.db, SHOP, "u", NOW);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const checked = (html: string) => /<input type="checkbox" name="exclude_bought" value="1" checked/.test(html);
    const get = async (path: string) => (await app.fetch(new Request(`${ORIGIN}${path}${path.includes("?") ? "&" : "?"}s=${encodeURIComponent(s)}`), deps)).text();
    const post = (o: Record<string, string>) =>
      app.fetch(new Request(`${ORIGIN}/admin/rules/save`, { method: "POST", body: new URLSearchParams({ s, name: "再入荷", status: "record_only", trigger: "favorite_restock", ...o }), headers: { Origin: ORIGIN } }), deps);

    expect(checked(await get("/admin/rules/new"))).toBe(true);
    expect(checked(await (await post({ op: "preview" })).text())).toBe(false);
    const saved = await post({ op: "save" });
    expect(saved.status).toBe(303);
    const path = new URL(saved.headers.get("Location")!, ORIGIN).pathname;
    const off = await get(path);
    expect(checked(off)).toBe(false);
    expect(off).not.toContain("その商品をまだ買っていない会員");
    expect(await deps.db.first(`SELECT trigger_opts FROM rules`)).toEqual({ trigger_opts: '{"exclude_bought":false,"unit":"product","axes":[]}' });

    const id = path.split("/").pop()!;
    await post({ op: "save", id, exclude_bought: "1" });
    const on = await get(path);
    expect(checked(on)).toBe(true);
    expect(on).toContain("その商品をまだ買っていない会員");
  });
});
