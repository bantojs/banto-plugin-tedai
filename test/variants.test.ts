import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { groupsOf, variantKey, variantLabel, variantOf, type SkuMap } from "../src/rules/variants";
import { processRuns } from "../src/runs/execute";
import { addFavorite } from "../src/store/favorites";
import { saveRule } from "../src/store/rules";
import { EMPTY_SETTINGS, saveSettings } from "../src/store/settings";
import type { Actions } from "../src/rules/actions";
import type { Trigger, TriggerKind } from "../src/rules/triggers";
import type { Deps } from "../src/deps";
import { BANTO, ENDPOINT, HOOK_SECRET, NOW, SECRET, SHOP, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const A = "c0000000-0000-4000-8000-00000000000a";
const none = { purchase: null, orders_at_least: null, spend_at_least: null };

describe("オプションのまとまり", () => {
  const skus: SkuMap = {
    r1: { o: { color: "red", size: "S" }, a: 0, p: 3000 },
    r2: { o: { color: "red", size: "M" }, a: 2, p: 3000 },
    b1: { o: { color: "blue", size: "S" }, a: 0, p: 2500 },
  };
  it("商品ごと・オプションを選ぶ・SKU ごとでまとめる", () => {
    expect([...groupsOf(skus, { unit: "product" }).values()]).toEqual([{ variant: {}, available: 2, minPrice: 2500 }]);
    const byColor = groupsOf(skus, { unit: "axes", axes: ["color"] });
    expect(byColor.get("color=red")).toEqual({ variant: { color: "red" }, available: 2, minPrice: 3000 });
    expect(byColor.get("color=blue")).toEqual({ variant: { color: "blue" }, available: 0, minPrice: 2500 });
    expect(groupsOf(skus, { unit: "sku" }).size).toBe(3);
    expect(variantKey(variantOf({ size: "S", color: "red" }, { unit: "sku" }))).toBe("color=red|size=S");
    // 選んだオプションを持たない商品は、持っている分だけ（無ければ商品ごと）
    expect(variantOf({ size: "S" }, { unit: "axes", axes: ["color"] })).toEqual({});
    expect(variantLabel({ color: "red", size: "S" }, { color: "カラー", size: "サイズ" })).toBe("カラー: red / サイズ: S");
  });
});

/** 偽の Banto: SKU ごとの在庫を変えられる */
function banto() {
  const stock: Record<string, number> = { r1: 0, r2: 2, b1: 0 };
  const seen: { method: string; path: string; body: unknown }[] = [];
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.origin !== BANTO || !u.pathname.startsWith("/api/v1/")) return undefined;
    const body = req.method === "GET" ? null : await req.clone().json().catch(() => null);
    seen.push({ method: req.method, path: u.pathname, body });
    if (u.pathname === "/api/v1/products/P1")
      return Response.json({
        id: "P1",
        slug: "tee",
        name: "T シャツ",
        published: true,
        option_names: { color: "カラー", size: "サイズ" },
        skus: [
          { id: "r1", price_jpy: 3000, available: stock.r1, options: { color: "red", size: "S" } },
          { id: "r2", price_jpy: 3000, available: stock.r2, options: { color: "red", size: "M" } },
          { id: "b1", price_jpy: 2500, available: stock.b1, options: { color: "blue", size: "S" } },
        ],
      });
    if (u.pathname === `/api/v1/customers/${A}/favorites`) return Response.json({ items: [{ customer_id: A, product_id: "P1" }] });
    if (u.pathname === `/api/v1/customers/${A}`) return Response.json({ id: A, name: "山田 花子", email: "a@example.com", marketing_consent: false });
    if (u.pathname.endsWith("/line-message")) return Response.json({ id: "l", status: "sent" });
    if (u.pathname === "/api/v1/coupons") return Response.json({ items: [] });
    return undefined;
  };
  return { stock, seen, route };
}

const line = (text: string): Actions => ({
  attribute: null,
  order_tags: [],
  coupon_id: null,
  message: { channel: "line", line_text: text, line_image_url: null, line_button_label: null, line_button_url: null, email_subject: "", email_body: "" },
  notify_slack: false,
  notify_email: false,
  wait_days: 0,
  recheck: true,
});

async function setup(b: ReturnType<typeof banto>, rules: { name: string; kind?: TriggerKind; unit: Trigger["unit"]; axes?: string[] }[], actions?: Actions) {
  const deps = makeDeps([exchangeRoute, b.route]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await addFavorite(deps.db, SHOP, A, "P1", NOW - 100);
  for (const r of rules)
    await saveRule(deps.db, SHOP, { id: null, name: r.name, status: actions ? "active" : "record_only", condition: none, trigger: { kind: r.kind ?? "favorite_restock", days: null, excludeBought: true, unit: r.unit, axes: r.axes ?? [] }, actions }, NOW);
  return deps;
}
let seq = 0;
const hook = async (deps: Deps, event: string, data: Record<string, unknown>) => {
  const body = JSON.stringify({ id: `v${++seq}`, event, created_at: "2027-01-15T08:00:00Z", shop_id: SHOP, attempt: 1, data: { shop_id: SHOP, ...data } });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};
const hitsBy = async (deps: Deps) =>
  (await deps.db.all<{ name: string; variant: string | null }>(`SELECT r.name, h.variant FROM rule_hits h JOIN rules r ON r.id = h.rule_id ORDER BY r.name, h.variant`)).map((h) => `${h.name}:${h.variant ?? "-"}`);

describe("オプションのまとまりで再入荷を見る", () => {
  it("赤 S だけ戻ると SKU ごとだけ、青 S が戻るとカラーごとと SKU ごと（商品ごとは合計がゼロでないので当たらない）", async () => {
    const b = banto();
    const deps = await setup(b, [
      { name: "1 商品", unit: "product" },
      { name: "2 カラー", unit: "axes", axes: ["color"] },
      { name: "3 SKU", unit: "sku" },
    ]);
    await hook(deps, "product.updated", { product_id: "P1" }); // 覚える
    b.stock.r1 = 1;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(await hitsBy(deps)).toEqual(['3 SKU:{"color":"red","size":"S"}']);
    b.stock.b1 = 3;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(await hitsBy(deps)).toEqual(['2 カラー:{"color":"blue"}', '3 SKU:{"color":"blue","size":"S"}', '3 SKU:{"color":"red","size":"S"}']);
    // カラーのまとまりは赤・青で別々に 1 回ずつ
    b.stock.r1 = 0;
    b.stock.r2 = 0;
    await hook(deps, "product.updated", { product_id: "P1" });
    b.stock.r2 = 1;
    await hook(deps, "product.updated", { product_id: "P1" });
    expect(await hitsBy(deps)).toContain('2 カラー:{"color":"red"}');
  });

  it("残りわずかは、知らせの SKU が入るまとまりで当てる", async () => {
    const b = banto();
    const deps = await setup(b, [{ name: "カラー", kind: "favorite_low_stock", unit: "axes", axes: ["color"] }]);
    await hook(deps, "inventory.low", { sku_id: "r2", product_id: "P1", available: 2, threshold: 3 });
    expect(await hitsBy(deps)).toEqual(['カラー:{"color":"red"}']);
  });

  it("文に {{variant}} を差し込み、そのまとまりが売り切れていたら送らない", async () => {
    const b = banto();
    const deps = await setup(b, [{ name: "SKU", unit: "sku" }], line("{{product_name}}（{{variant}}）が再入荷しました"));
    // このテストではお客様ごとの上限を外す（2 通目を上限で待たせず、売り切れの確かめまで進める）
    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, cap_day: 0, cap_week: 0 }, NOW);
    await hook(deps, "product.updated", { product_id: "P1" });
    b.stock.r1 = 1;
    await hook(deps, "product.updated", { product_id: "P1" });
    await processRuns(deps, 3);
    expect(b.seen.find((x) => x.path.endsWith("/line-message"))!.body).toEqual({ text: "T シャツ（カラー: red / サイズ: S）が再入荷しました" });
    // 別のまとまり（青 S）が戻ったが、送る前にまた売り切れた
    b.stock.b1 = 1;
    await hook(deps, "product.updated", { product_id: "P1" });
    b.stock.b1 = 0;
    await processRuns(deps, 3);
    expect(await deps.db.first(`SELECT status, last_error FROM runs WHERE variant LIKE '%blue%'`)).toEqual({ status: "skipped", last_error: "sold_out" });
  });
});

describe("画面の見る単位", () => {
  it("オプションを選んで保存し、開き直しても残る。オプションを選ばなければ直すよう出す", async () => {
    const { signSession } = await import("../src/admin/session");
    const b = banto();
    const deps = await setup(b, []);
    await hook(deps, "product.updated", { product_id: "P1" }); // ルールが無いので読まない
    const { backfillProductStates } = await import("../src/rules/favorites");
    const { ConnectionRepo } = await import("../src/store/connections");
    await saveRule(deps.db, SHOP, { id: null, name: "仮", status: "record_only", condition: none, trigger: { kind: "favorite_restock", days: null } }, NOW);
    await backfillProductStates(deps, (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!, 3); // オプションの名前を覚える
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const body = (o: [string, string][]) => {
      const f = new URLSearchParams([["s", s], ["name", "色の再入荷"], ["status", "record_only"], ["trigger", "favorite_restock"], ["exclude_bought", "1"], ...o]);
      return app.fetch(new Request(`${ORIGIN}/admin/rules/save`, { method: "POST", body: f, headers: { Origin: ORIGIN } }), deps);
    };
    expect(await (await body([["op", "save"], ["variant_unit", "axes"]])).text()).toContain("オプションを 1 つ以上");
    const saved = await body([["op", "save"], ["variant_unit", "axes"], ["variant_axes", "color"]]);
    expect(saved.status).toBe(303);
    const html = await (await app.fetch(new Request(`${ORIGIN}${new URL(saved.headers.get("Location")!, ORIGIN).pathname}?s=${encodeURIComponent(s)}`), deps)).text();
    expect(html).toMatch(/name="variant_unit" value="axes" checked/);
    expect(html).toMatch(/name="variant_axes" value="color" checked/);
    expect(html).toContain("カラーごと");
  });
});
