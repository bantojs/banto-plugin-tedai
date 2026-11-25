import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/admin/session";
import { processRuns } from "../src/runs/execute";
import { recordOrder } from "../src/store/purchases";
import { saveRule } from "../src/store/rules";
import { EMPTY_SETTINGS, saveSettings } from "../src/store/settings";
import type { Actions } from "../src/rules/actions";
import type { Deps } from "../src/deps";
import { BANTO, ENDPOINT, HOOK_SECRET, NOW, SECRET, SHOP, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const A = "c0000000-0000-4000-8000-00000000000a";
const none = { purchase: null, orders_at_least: null, spend_at_least: null };
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

function banto() {
  const seen: { path: string; body: unknown }[] = [];
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.origin === "https://api.resend.com") {
      seen.push({ path: "resend", body: await req.clone().json() });
      return Response.json({ id: "m" });
    }
    if (u.origin !== BANTO || !u.pathname.startsWith("/api/v1/")) return undefined;
    seen.push({ path: u.pathname, body: req.method === "GET" ? null : await req.clone().json().catch(() => null) });
    if (u.pathname === "/api/v1/products/P1") return Response.json({ id: "P1", slug: "tee", name: "T シャツ", published: true, skus: [{ id: "s1", price_jpy: 3000, available: 1, options: {} }] });
    if (u.pathname === `/api/v1/customers/${A}`) return Response.json({ id: A, name: "山田 花子", email: "a@example.com", marketing_consent: false });
    if (u.pathname.endsWith("/line-message")) return Response.json({ id: "l", status: "sent" });
    if (u.pathname === "/api/v1/coupons") return Response.json({ items: [] });
    return undefined;
  };
  return { seen, route };
}

async function setup(b: ReturnType<typeof banto>, actions?: Actions) {
  const deps = makeDeps([exchangeRoute, b.route]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await saveRule(deps.db, SHOP, { id: null, name: "カゴ落ち", status: actions ? "active" : "record_only", condition: none, trigger: { kind: "checkout_abandoned", days: null }, actions }, NOW);
  return deps;
}
let seq = 0;
const abandoned = async (deps: Deps, reservation: string, startedAt = NOW - 2400) => {
  const body = JSON.stringify({
    id: `ab${++seq}`,
    event: "checkout.abandoned",
    created_at: new Date(NOW * 1000).toISOString(),
    shop_id: SHOP,
    attempt: 1,
    data: { reservation_id: reservation, shop_id: SHOP, customer_id: A, reason: "expired", items: [{ sku_id: "s1", product_id: "P1", qty: 1, unit_price_jpy: 3000 }], subtotal_jpy: 3000, started_at: new Date(startedAt * 1000).toISOString() },
  });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};

describe("カゴ落ち", () => {
  it("会員 × カゴで 1 回当たり、1 時間待ってから、カゴの商品を差し込んで送る", async () => {
    const b = banto();
    const deps = await setup(b, line("{{name}} さん、{{product_name}} が待っています {{product_url}}"));
    expect((await abandoned(deps, "r1")).status).toBe(200);
    await abandoned(deps, "r1"); // 同じカゴの知らせが重なっても 1 回
    expect(await deps.db.all(`SELECT hit_key FROM rule_hits`)).toEqual([{ hit_key: `${A}:cart:r1` }]);
    expect((await deps.db.first<{ due_at: number }>(`SELECT due_at FROM runs`))!.due_at).toBe(NOW + 3600);
    expect(await processRuns(deps, 3)).toBe(0);
    await processRuns({ ...deps, now: () => NOW + 3601 }, 3);
    expect(b.seen.find((x) => x.path.endsWith("/line-message"))!.body).toEqual({ text: `山田 花子 さん、T シャツ が待っています ${BANTO}/my-shop/products/tee` });
  });

  it("レジを始めたあとに買っていたら送らない", async () => {
    const b = banto();
    const deps = await setup(b, line("まだカゴに入っています"));
    await abandoned(deps, "r2", NOW - 2400);
    await recordOrder(deps.db, SHOP, { order_id: "o1", customer_id: A, total_jpy: 3000, ordered_at: NOW - 600, cancelled: false, items: [{ product_id: "P1", qty: 1, unit_price_jpy: 3000 }], banto_updated_at: null, complete: true });
    await processRuns({ ...deps, now: () => NOW + 3601 }, 3);
    expect(await deps.db.first(`SELECT status, last_error FROM runs`)).toEqual({ status: "skipped", last_error: "bought_after" });
    expect(b.seen.some((x) => x.path.endsWith("/line-message"))).toBe(false);
  });

  it("受け取った時刻を画面に出し、まだ受け取っていなければ出来事を足すよう案内する", async () => {
    const b = banto();
    const deps = await setup(b);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const page = async () =>
      (
        await app.fetch(
          new Request(`${ORIGIN}/admin/rules/save`, { method: "POST", body: new URLSearchParams({ s, op: "preview", name: "x", status: "draft", trigger: "checkout_abandoned" }), headers: { Origin: ORIGIN } }),
          deps,
        )
      ).text();
    expect(await page()).toContain("checkout.abandoned");
    await abandoned(deps, "r3");
    expect(await page()).toContain("カゴ落ちを最後に受け取ったのは");
  });
});

describe("試しに 1 通送る", () => {
  it("運営者の宛先へ送り、送り手が断ったら理由を出す", async () => {
    const b = banto();
    const deps = await setup(b);
    deps.config.mail = { transport: "resend", apiKey: "re_test" };
    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "店 <news@shop.example>", operator_email: "owner@shop.example" }, NOW);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const send = (d: Deps) => app.fetch(new Request(`${ORIGIN}/admin/settings/test-mail`, { method: "POST", body: new URLSearchParams({ s }), headers: { Origin: ORIGIN } }), d);
    const ok = await send(deps);
    expect(ok.headers.get("Location")).toContain("msg=test_sent");
    expect(b.seen.find((x) => x.path === "resend")!.body).toMatchObject({ from: "店 <news@shop.example>", to: ["owner@shop.example"] });
    const refusing: Route = (req) => (new URL(req.url).origin === "https://api.resend.com" ? Response.json({ message: "domain not verified" }, { status: 403 }) : undefined);
    // 続けて押すと送らない（30 秒に 1 通）
    const again = await send(deps);
    expect(await again.text()).toContain("30 秒に 1 通");
    expect(b.seen.filter((x) => x.path === "resend")).toHaveLength(1);
    const bad = await send({ ...deps, now: () => NOW + 31, fetch: makeDeps([refusing]).fetch });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("試しに送れませんでした: Resend 403");
  });
});
