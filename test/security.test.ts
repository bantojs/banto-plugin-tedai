import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { runScheduled } from "../src/jobs";
import { fromAllowed, mailer, readMailConfig } from "../src/mail/transport";
import { signSession } from "../src/admin/session";
import { claimOwner, resetAdminUsers, transferOwner } from "../src/store/admin-users";
import { enqueueNotice, retryFailedNotices, countFailed } from "../src/store/notices";
import { EMPTY_SETTINGS, getKv, getSettings, saveSettings, SELF_ORIGIN } from "../src/store/settings";
import { forgetDelivery, recordDelivery } from "../src/store/deliveries";
import { forgetNotConnected } from "../src/store/connections";
import { migrate, MIGRATIONS } from "../src/store/migrations";
import { BANTO, ENDPOINT, HOOK_SECRET, NOW, SECRET, SHOP, exchangeRoute, makeDeps, signHook, signPluginTicket, sqliteDb, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";

async function connected(routes: Route[] = []) {
  const deps = makeDeps([exchangeRoute, ...routes]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  return deps;
}

describe("公開の前の見直し", () => {
  it("hooks の受け口は Content-Length の無い大きな本文を上限で読むのをやめる", async () => {
    const deps = await connected();
    const big = new Uint8Array(1024 * 1024 + 10).fill(65);
    const stream = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < big.length; i += 64 * 1024) ctrl.enqueue(big.subarray(i, i + 64 * 1024));
        ctrl.close();
      },
    });
    const res = await app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body: stream, duplex: "half" } as RequestInit), deps);
    expect(res.status).toBe(413);
  });

  it("配信停止のリンクに使う URL は、確かめた作業の券のある要求でだけ覚える", async () => {
    const deps = await connected();
    await deps.db.run(`DELETE FROM kv WHERE key = ?`, [SELF_ORIGIN]);
    // 券の無い・つないでいないショップの要求では覚えない
    await app.fetch(new Request(`https://other.example.workers.dev/admin?banto_ticket=x&shop_id=nonexistent`), deps);
    expect(await getKv(deps.db, SELF_ORIGIN)).toBeNull();
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    await app.fetch(new Request(`${ORIGIN}/admin/rules?s=${encodeURIComponent(s)}`), deps);
    expect(await getKv(deps.db, SELF_ORIGIN)).toBe(ORIGIN);
  });

  it("前の版から上げた（持ち主のいない・コードの無い）ショップは、だれが開いても持ち主にならず、つなぎ直しを案内する", async () => {
    const deps = makeDeps([exchangeRoute]);
    expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
    // 前の版にはコードが無い
    await deps.db.run(`DELETE FROM kv WHERE key LIKE 'owner_claim:%'`);
    const ticket = await signPluginTicket(HOOK_SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "x" }, NOW);
    const res = await app.fetch(new Request(`${ORIGIN}/admin?shop_id=${SHOP}&endpoint_id=${ENDPOINT}&banto_ticket=${ticket}`), deps);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("つなぎ直し");
    expect(await deps.db.first(`SELECT user_id FROM admin_users`)).toBeNull();
  });

  it("管理画面と持ち主のコードのフォームは、大きすぎる本文を読まない", async () => {
    const deps = await connected();
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const big = `s=${encodeURIComponent(s)}&name=${"x".repeat(300 * 1024)}`;
    const r1 = await app.fetch(new Request(`${ORIGIN}/admin/sets`, { method: "POST", body: big, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN } }), deps);
    expect(r1.status).toBe(401);
    expect(await deps.db.first(`SELECT id FROM product_sets`)).toBeNull();
    const r2 = await app.fetch(new Request(`${ORIGIN}/admin/claim`, { method: "POST", body: `code=${"x".repeat(300 * 1024)}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), deps);
    expect(r2.status).toBe(413);
  });

  it("SMTP の暗号化なし（SMTP_TLS=off）は受け付けない", () => {
    expect(readMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example", SMTP_TLS: "off" }).problems).toContain("SMTP_TLS");
  });

  it("MAIL_FROM_DOMAINS を決めたら、ほかのドメインの送り元では送らず、設定にも保存させない", async () => {
    const cfg = readMailConfig({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: "k", MAIL_FROM_DOMAINS: "shop-a.example, news.shop-a.example" }).config!;
    expect(fromAllowed(cfg, "店 A <news@shop-a.example>")).toBe(true);
    expect(fromAllowed(cfg, "x@mail.shop-a.example")).toBe(true);
    expect(fromAllowed(cfg, "店 B <news@shop-b.example>")).toBe(false);
    // ショップごとに決める（shop-a=…）と、ほかのショップはそのドメインを使えない
    const per = readMailConfig({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: "k", MAIL_FROM_DOMAINS: `shop-a=shop-a.example, slug:shop-b=shop-b.example, id:${SHOP}=by-id.example, common.example` }).config!;
    const shopA = { slug: "shop-a", id: "aaaaaaaa-0000-4000-8000-000000000000" };
    expect(fromAllowed(per, "news@shop-a.example", shopA)).toBe(true);
    expect(fromAllowed(per, "news@shop-b.example", shopA)).toBe(false);
    expect(fromAllowed(per, "news@common.example", shopA)).toBe(true);
    expect(fromAllowed(per, "news@shop-a.example")).toBe(false);
    // ショップの ID でも書ける（URL の名前を変えても移らない）
    expect(fromAllowed(per, "news@by-id.example", { slug: "renamed", id: SHOP })).toBe(true);
    expect(fromAllowed(per, "news@by-id.example", shopA)).toBe(false);
    // 別のショップの ID を自分の URL の名前にしても、そのショップのドメインは使えない
    expect(fromAllowed(per, "news@by-id.example", { slug: SHOP, id: "bbbbbbbb-0000-4000-8000-000000000000" })).toBe(false);
    const legacy = readMailConfig({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: "k", MAIL_FROM_DOMAINS: `${SHOP}=x.example` }).config!;
    expect(fromAllowed(legacy, "a@x.example", { slug: SHOP, id: "bbbbbbbb-0000-4000-8000-000000000000" })).toBe(false);
    // 表示名に < > @ を入れた見せかけは送らない
    expect(fromAllowed(cfg, '"info@shop-b.example" <x@shop-a.example>')).toBe(false);
    let called = 0;
    const m = mailer(cfg, { fetch: (async () => (called++, new Response("{}"))) as typeof fetch, ehloName: "x" });
    await expect(m.send({ from: "news@shop-b.example", to: "a@example.com", subject: "s", text: "t" })).rejects.toThrow("from_not_allowed");
    expect(called).toBe(0);
    // Resend には確かめた形の送り元を渡す
    let sentFrom = "";
    const ok = mailer(cfg, { fetch: (async (_i: RequestInfo | URL, init?: RequestInit) => ((sentFrom = (JSON.parse(String(init!.body)) as { from: string }).from), new Response("{}"))) as typeof fetch, ehloName: "x" });
    await ok.send({ from: "  店 A   <news@shop-a.example> ", to: "a@example.com", subject: "s", text: "t" });
    expect(sentFrom).toBe("店 A <news@shop-a.example>");

    const deps = await connected();
    deps.config.mail = cfg;
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const res = await app.fetch(
      new Request(`${ORIGIN}/admin/settings`, { method: "POST", body: new URLSearchParams({ s, mail_from: "店 B <news@shop-b.example>" }), headers: { Origin: ORIGIN } }),
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("MAIL_FROM_DOMAINS");
  });

  it("途中で切れた注文のお知らせは、まとめての送り直しに入れない（送れていたかもしれないため）", async () => {
    const deps = await connected();
    await enqueueNotice(deps.db, SHOP, "o1", "received", NOW);
    await enqueueNotice(deps.db, SHOP, "o2", "received", NOW);
    await deps.db.run(`UPDATE notice_sends SET status = 'failed', last_error = 'interrupted' WHERE order_id = 'o1'`);
    await deps.db.run(`UPDATE notice_sends SET status = 'failed', last_error = 'mail 503' WHERE order_id = 'o2'`);
    expect(await countFailed(deps.db, SHOP, NOW)).toBe(1);
    expect(await retryFailedNotices(deps.db, SHOP, NOW)).toBe(1);
    expect(await deps.db.first(`SELECT status FROM notice_sends WHERE order_id = 'o1'`)).toEqual({ status: "failed" });
  });

  it("Banto にトークンを断られたショップは、6 時間は突き合わせを試さない。つなぎ直すとまた試す", async () => {
    let calls = 0;
    const revoked: Route = (req) => (new URL(req.url).pathname.startsWith("/api/v1/") ? (calls++, Response.json({ error: { code: "unauthorized" } }, { status: 401 })) : undefined);
    const deps = await connected([revoked]);
    await runScheduled(deps);
    const first = calls;
    expect(first).toBeGreaterThan(0);
    await runScheduled({ ...deps, now: () => NOW + 600 });
    expect(calls).toBe(first);
    await runScheduled({ ...deps, now: () => NOW + 7 * 3600 });
    expect(calls).toBeGreaterThan(first);
    const before = calls;
    await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), { ...deps, now: () => NOW + 7 * 3600 + 60 });
    await runScheduled({ ...deps, now: () => NOW + 7 * 3600 + 120 });
    expect(calls).toBeGreaterThan(before);
  });

  it("持ち主を移すのは、移す人がまだ持ち主のときだけ（同時に 2 人へ移しても、持ち主は 1 人）", async () => {
    const deps = await connected();
    for (const u of ["a", "b"]) await deps.db.run(`INSERT INTO admin_users (shop_id, user_id, role, at) VALUES (?, ?, 'member', ?)`, [SHOP, u, NOW]);
    const [r1, r2] = await Promise.all([transferOwner(deps.db, SHOP, "u", "a", NOW), transferOwner(deps.db, SHOP, "u", "b", NOW)]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    expect((await deps.db.all(`SELECT user_id FROM admin_users WHERE role = 'owner'`)).length).toBe(1);
    // 持ち主がいるあいだは、つなぎ直しても持ち主のコードを出さず、使える人も消さない
    expect(await resetAdminUsers(deps.db, SHOP, NOW)).toBeNull();
    expect((await deps.db.all(`SELECT user_id FROM admin_users`)).length).toBe(3);
  });

  it("受け取った配信の重なりはショップごとに見る", async () => {
    const deps = await connected();
    expect(await recordDelivery(deps.db, { id: "d1", shop_id: SHOP, event: "order.paid" }, NOW)).toBe(true);
    expect(await recordDelivery(deps.db, { id: "d1", shop_id: "other", event: "order.paid" }, NOW)).toBe(true);
    await forgetDelivery(deps.db, "other", "d1");
    expect(await deps.db.all(`SELECT shop_id FROM hook_deliveries`)).toEqual([{ shop_id: SHOP }]);
  });

  it("送り手・返信先・運営者への宛先を変えるのは持ち主だけ（許した人が送っても前のまま）", async () => {
    const deps = await connected();
    deps.config.mail = { transport: "resend", apiKey: "re_test" };
    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "店 <news@shop.example>", operator_email: "owner@shop.example" }, NOW);
    await deps.db.run(`INSERT INTO admin_users (shop_id, user_id, role, at) VALUES (?, 'm', 'member', ?)`, [SHOP, NOW]);
    const post = async (user: string) => {
      const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: user }, NOW);
      const body = new URLSearchParams({ s, mail_from: "店 <x@evil.example>", operator_email: "x@evil.example", reply_to: "x@evil.example", sender_name: "店", cap_day: "1", cap_week: "3", quiet_start: "", quiet_end: "", mail_accent: "#335577" });
      return app.fetch(new Request(`${ORIGIN}/admin/settings`, { method: "POST", body, headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" } }), deps);
    };
    expect((await post("m")).status).toBe(303);
    expect(await getSettings(deps.db, SHOP)).toMatchObject({ mail_from: "店 <news@shop.example>", operator_email: "owner@shop.example", reply_to: "", sender_name: "店" });
    expect((await post("u")).status).toBe(303);
    expect(await getSettings(deps.db, SHOP)).toMatchObject({ mail_from: "店 <x@evil.example>", operator_email: "x@evil.example" });
  });

  it("つないでいないショップの ID はしばらく D1 を読まずに断り、つないだら受け取る", async () => {
    forgetNotConnected();
    const deps = makeDeps([exchangeRoute]);
    const body = JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", event: "customer.created", created_at: new Date(NOW * 1000).toISOString(), shop_id: SHOP, attempt: 1, data: {} });
    const send = async () => app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
    expect((await send()).status).toBe(401);
    let reads = 0;
    const first = deps.db.first.bind(deps.db);
    deps.db.first = ((sql: string, params?: Parameters<typeof first>[1]) => (sql.includes("FROM connections") && reads++, first(sql, params))) as typeof deps.db.first;
    expect((await send()).status).toBe(401);
    expect(reads).toBe(0);
    expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
    expect((await send()).status).toBe(200);
  });

  it("2 つの isolate が同時に表を作っても、片方の失敗で止まらない", async () => {
    const db = sqliteDb();
    await Promise.all([migrate(db), migrate(db)]);
    expect((await db.all(`SELECT id FROM tedai_migrations`)).length).toBe(MIGRATIONS.length);
    expect(await db.all(`SELECT sending_at FROM notice_sends`)).toEqual([]);
  });
});
