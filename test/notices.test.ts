import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/admin/session";
import { processNotices } from "../src/notices/send";
import { checkTemplate, defaultTemplate, DEFAULT_HTML, kindOf } from "../src/notices/kinds";
import { parseMailBody } from "../src/mail/html";
import { enqueueNotice, saveTemplate } from "../src/store/notices";
import { NOTICE_BUDGET, NOTICE_QUERY_BUDGET } from "../src/jobs";
import { permanentMailError, redactAddresses } from "../src/mail/transport";
import { EMPTY_SETTINGS, saveSettings } from "../src/store/settings";
import type { Deps } from "../src/deps";
import { BANTO, ENDPOINT, HOOK_SECRET, NOW, SECRET, SHOP, TOKEN, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const ORDER = "o0000000-0000-4000-8000-000000000001";

const exchangeWith = (scopes: string[]): Route => async (req) => {
  const res = await exchangeRoute(req);
  if (!res) return undefined;
  const j = (await res.json()) as Record<string, unknown>;
  return Response.json({ ...j, scopes });
};

const orderJson = (pii: boolean, extra: Record<string, unknown> = {}) => ({
  id: ORDER,
  number: 1042,
  status: "paid",
  payment_status: "paid",
  payment_provider: "stripe",
  customer_id: null,
  total_jpy: 9400,
  shipping_jpy: 600,
  discount_jpy: 0,
  fee_jpy: 0,
  discounts: [],
  items: [{ product_name: "リネンシャツ", sku_name: "白 / M", qty: 1, unit_price_jpy: 8800 }],
  customer: pii ? { email: "guest@example.com", name: "<b>佐藤</b> 一郎", shipping_address: { state: "東京都" } } : { masked: true, prefecture: "東京都" },
  ...extra,
});

function banto(opts: { pii?: boolean; order?: Record<string, unknown>; mailFail?: number; mailStatus?: number; orderStatus?: number } = {}) {
  const seen: { url: string; body: unknown; headers: Headers }[] = [];
  let fails = opts.mailFail ?? 0;
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === `/api/v1/orders/${ORDER}`) {
      expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      if (opts.orderStatus) return Response.json({ error: "not_found" }, { status: opts.orderStatus });
      return Response.json(opts.order ?? orderJson(opts.pii !== false));
    }
    if (req.url === "https://api.resend.com/emails") {
      seen.push({ url: req.url, body: await req.json(), headers: req.headers });
      if (fails > 0) {
        fails--;
        return new Response(`rejected guest@example.com`, { status: opts.mailStatus ?? 503 });
      }
      return Response.json({ id: "m1" });
    }
    return undefined;
  };
  return { route, seen };
}

async function setup(b: ReturnType<typeof banto>, scopes = ["orders:read", "orders:pii"]) {
  const deps = makeDeps([exchangeWith(scopes), b.route]);
  deps.config.mail = { transport: "resend", apiKey: "re_test" };
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <order@shop.example>", sender_contact: "info@shop.example" }, NOW);
  return deps;
}

const hook = async (deps: Deps, id: string, event: string, data: Record<string, unknown>) => {
  const body = JSON.stringify({ id, event, created_at: new Date(NOW * 1000).toISOString(), shop_id: SHOP, attempt: 1, data: { order_id: ORDER, shop_id: SHOP, ...data } });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};

const sends = (deps: Deps) => deps.db.all<{ kind: string; status: string; result: string | null; order_number: number | null; attempts: number }>(`SELECT kind, status, result, order_number, attempts FROM notice_sends ORDER BY kind`);

describe("出来事 → 知らせの種類", () => {
  it("決済の注文は order.paid、未入金の注文は order.created で受付。入金の記録は入金の確認", () => {
    expect(kindOf("order.paid", {})).toBe("received");
    expect(kindOf("order.paid", { recorded_payment: true })).toBe("paid");
    expect(kindOf("order.created", { payment_status: "paid" })).toBeNull();
    expect(kindOf("order.created", { payment_status: "unpaid" })).toBe("received");
    expect(kindOf("order.shipped", {})).toBe("shipped");
    expect(kindOf("order.cancelled", {})).toBe("cancelled");
    expect(kindOf("customer.deleted", {})).toBeNull();
  });
});

describe("文面の確かめ", () => {
  it("受付と発送は明細が必須、発送は追跡番号も。知らない差し込みは断る", () => {
    const t = { ...defaultTemplate("received"), body: "ありがとうございます" };
    expect(checkTemplate(t, []).join()).toContain("{{order_details}}");
    expect(checkTemplate({ ...defaultTemplate("shipped"), body: "{{order_details}}" }, []).join()).toContain("{{tracking}}");
    expect(checkTemplate({ ...defaultTemplate("shipped"), subject: "{{tracking}}" }, []).join()).toContain("件名には使えません");
    expect(checkTemplate({ ...defaultTemplate("paid"), body: "{{coupon_code}}" }, []).join()).toContain("使えない差し込み");
    expect(checkTemplate({ ...defaultTemplate("received"), body: "{{order_details}}\n{{order_details}}" }, []).join()).toContain("1 回だけ");
    for (const k of ["received", "paid", "shipped", "cancelled"] as const) {
      expect(checkTemplate(defaultTemplate(k), [])).toEqual([]);
      expect(checkTemplate({ ...defaultTemplate(k), format: "html", body: DEFAULT_HTML[k] }, parseMailBody(DEFAULT_HTML[k], ["order_details"]).errors)).toEqual([]);
    }
    expect(parseMailBody("明細: {{order_details}}", ["order_details"]).errors.join()).toContain("単独");
  });
});

describe("注文のお知らせを送る", () => {
  it("送ると決めた種類だけ積み、ゲストにも宛先を読んで送る（宛先とお名前は D1 に置かない）", async () => {
    const b = banto();
    const deps = await setup(b);
    // 送らない設定のあいだは積まない
    await hook(deps, "d0", "order.paid", { customer_id: null });
    expect(await sends(deps)).toEqual([]);

    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    expect((await hook(deps, "d1", "order.paid", { customer_id: null })).status).toBe(200);
    // 同じ注文の同じ種類は 1 回だけ（別の配信 ID で来ても）
    await hook(deps, "d2", "order.paid", { customer_id: null });
    expect(await processNotices(deps, 10)).toBe(1);
    expect(b.seen).toHaveLength(1);
    const m = b.seen[0]!.body as Record<string, unknown>;
    expect(m["to"]).toEqual(["guest@example.com"]);
    expect(m["subject"]).toBe("【テストの店】ご注文ありがとうございます（注文番号 1042）");
    expect(String(m["text"])).toContain("<b>佐藤</b> 一郎 様");
    expect(String(m["text"])).toContain("リネンシャツ（白 / M） × 1");
    expect(String(m["text"])).toContain("合計（税込）: ¥9,400");
    expect(String(m["text"])).toContain(`${BANTO}/my-shop/orders/lookup?banto_order=1042`);
    expect(String(m["text"])).not.toContain("banto_member");
    expect(String(m["text"])).not.toContain("配信を止める");
    expect(m["html"]).toBeUndefined();
    expect(m["headers"]).toBeUndefined();
    expect(b.seen[0]!.headers.get("Idempotency-Key")).toBe(`tedai-n-${SHOP}-${ORDER}-received`);
    expect(await sends(deps)).toEqual([{ kind: "received", status: "done", result: "sent", order_number: 1042, attempts: 1 }]);
    const dump = JSON.stringify(await deps.db.all(`SELECT * FROM notice_sends`));
    expect(dump).not.toContain("guest@example.com");
    expect(dump).not.toContain("佐藤");
  });

  it("飾りありでは明細を表にし、お名前はエスケープする。会員の注文の確認ページは会員の印つき", async () => {
    const b = banto({ order: orderJson(true, { customer_id: "c1" }) });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("shipped"), enabled: true, format: "html", body: DEFAULT_HTML.shipped }, NOW);
    await hook(deps, "d1", "order.shipped", {});
    await processNotices(deps, 10);
    const m = b.seen[0]!.body as Record<string, string>;
    expect(m["html"]).toContain("&lt;b&gt;佐藤&lt;/b&gt; 一郎 様");
    expect(m["html"]).not.toContain("<b>佐藤");
    expect(m["html"]).toContain("リネンシャツ（白 / M） × 1");
    expect(m["html"]).toContain("¥9,400");
    expect(m["html"]).toContain(`href="${BANTO}/my-shop/orders/lookup?banto_order=1042&amp;banto_member=1"`);
    expect(m["html"]).not.toContain("配信を止める");
    expect(m["text"]).toContain("注文番号: 1042");
  });

  it("orders:pii の無いつなぎ方は送らずに失敗にし、つなぎ直しを案内する", async () => {
    const b = banto({ pii: false });
    const deps = await setup(b, ["orders:read"]);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    expect(b.seen).toHaveLength(0);
    expect((await sends(deps))[0]).toMatchObject({ status: "failed", result: "no_pii" });
  });

  it("送れなければあとでやり直し、5 回で失敗にする", async () => {
    const b = banto({ mailFail: 1 });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    expect((await sends(deps))[0]).toMatchObject({ status: "pending", attempts: 1 });
    // 5 分後まではやり直さない
    expect(await processNotices(deps, 10)).toBe(0);
    const later = { ...deps, now: () => NOW + 301 };
    await processNotices(later, 10);
    expect((await sends(deps))[0]).toMatchObject({ status: "done", result: "sent" });
    expect(b.seen).toHaveLength(2);
    expect(b.seen[0]!.headers.get("Idempotency-Key")).toBe(b.seen[1]!.headers.get("Idempotency-Key"));
  });

  it("order.created・order.shipped は送る種類が無ければ配信 ID も書かない", async () => {
    const deps = await setup(banto());
    await hook(deps, "d1", "order.shipped", {});
    await hook(deps, "d2", "order.created", { payment_status: "unpaid" });
    expect(await deps.db.all(`SELECT id FROM hook_deliveries`)).toEqual([]);
  });
});

describe("注文のお知らせ: 道すじと上限", () => {
  const counting = (deps: Deps) => {
    let queries = 0;
    let fetches = 0;
    const db = deps.db;
    const f = deps.fetch;
    const wrapped: Deps = {
      ...deps,
      db: {
        all: (q, p) => (queries++, db.all(q, p)),
        first: (q, p) => (queries++, db.first(q, p)),
        run: (q, p) => (queries++, db.run(q, p)),
        batch: (st) => (queries++, db.batch(st)),
      },
      fetch: ((i: RequestInfo | URL, init?: RequestInit) => (fetches++, f(i, init))) as typeof fetch,
    };
    return { deps: wrapped, counts: () => ({ queries, fetches }) };
  };

  it("代金引換: 受付は order.created で 1 通、入金の記録では受付を重ねず入金の確認だけ", async () => {
    const b = banto({ order: orderJson(true, { payment_provider: "cod", payment_status: "unpaid", fee_jpy: 330 }) });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("paid"), enabled: true }, NOW);
    await hook(deps, "d1", "order.created", { payment_status: "unpaid" });
    await hook(deps, "d2", "order.paid", { recorded_payment: true, payment_status: "paid" });
    await processNotices(deps, 10);
    expect((await sends(deps)).map((r) => [r.kind, r.status])).toEqual([
      ["paid", "done"],
      ["received", "done"],
    ]);
    const received = b.seen.map((x) => String((x.body as Record<string, unknown>)["text"])).find((t) => t.includes("ご注文を承りました"))!;
    expect(received).toContain("代金引換（未入金）");
    expect(received).toContain("代引き手数料: ¥330");
  });

  it("積んだあとに送らない設定にしたら送らない。注文が無ければやめる。失敗は画面から送り直せる", async () => {
    const b = banto({ orderStatus: 404 });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    expect((await sends(deps))[0]).toMatchObject({ status: "skipped", result: "order_not_found" });

    const b2 = banto();
    const deps2 = await setup(b2);
    await saveTemplate(deps2.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps2, "d1", "order.paid", {});
    await saveTemplate(deps2.db, SHOP, { ...defaultTemplate("received"), enabled: false }, NOW);
    await processNotices(deps2, 10);
    expect(b2.seen).toHaveLength(0);
    expect((await sends(deps2))[0]).toMatchObject({ status: "skipped", result: "disabled" });

    const b3 = banto({ mailFail: 1, mailStatus: 422 });
    const deps3 = await setup(b3);
    await saveTemplate(deps3.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps3, "d1", "order.paid", {});
    await processNotices(deps3, 10);
    expect((await sends(deps3))[0]).toMatchObject({ status: "failed", result: "rejected" });
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const r = await app.fetch(new Request(`${ORIGIN}/admin/notices/retry`, { method: "POST", body: new URLSearchParams({ s, order_id: ORDER, kind: "received" }), headers: { Origin: ORIGIN } }), deps3);
    expect(r.status).toBe(303);
    await processNotices(deps3, 10);
    expect((await sends(deps3))[0]).toMatchObject({ status: "done", result: "sent" });
  });

  it("送り手の応答や形の誤りにお客様のアドレスが入っても、記録とログに残さない", async () => {
    const b = banto({ mailFail: 5, mailStatus: 550 });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    // 送り手の応答の文（アドレスを含む）は残さず、コードだけ（Resend の 5xx はやり直す）
    const row = await deps.db.first<{ last_error: string }>(`SELECT last_error FROM notice_sends`);
    expect(row!.last_error).toBe("mail 550");

    // 手代が送れない形のアドレス（Banto のレジは通る）はやり直さずにやめる
    const bad = banto({ order: orderJson(true, { customer: { email: "a;b@example.jp", name: "x" } }) });
    const deps2 = await setup(bad);
    await saveTemplate(deps2.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps2, "d1", "order.paid", {});
    await processNotices(deps2, 10);
    expect((await sends(deps2))[0]).toMatchObject({ status: "skipped", result: "invalid_email" });
    expect(JSON.stringify(await deps2.db.all(`SELECT * FROM notice_sends`))).not.toContain("example.jp");
  });

  it("取ったまま切れた行は 1 回と数え、続けば失敗で止める", async () => {
    const deps = await setup(banto());
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    // 4 回取ったまま切れた（期限を延ばし、数を進めただけ）
    await deps.db.run(`UPDATE notice_sends SET attempts = 5, due_at = ?`, [NOW]);
    await processNotices(deps, 10);
    expect((await sends(deps))[0]).toMatchObject({ status: "failed", attempts: 6 });
    expect((await deps.db.first<{ last_error: string }>(`SELECT last_error FROM notice_sends`))!.last_error).toBe("interrupted");
  });

  it("Cron 1 回の知らせは D1 と fetch の上限（無料プランの 50）に余裕を残す", async () => {
    const b = banto();
    const base = await setup(b);
    await saveTemplate(base.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    for (let i = 0; i < 12; i++) await enqueueNotice(base.db, SHOP, ORDER.replace(/1$/, String(i).padStart(1, "0")) + (i > 9 ? "x" : ""), "received", NOW);
    const c = counting(base);
    await processNotices(c.deps, NOTICE_BUDGET);
    expect(c.counts().queries).toBeLessThanOrEqual(12);
    expect(c.counts().fetches).toBeLessThanOrEqual(NOTICE_BUDGET * 2);
  });
});

describe("注文のお知らせ: 再レビューの指摘", () => {
  it("Cron の知らせは、ショップがいくつあっても決めた D1 の問い合わせの数で止める", async () => {
    const b = banto();
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    // 3 つのショップに 1 通ずつ（2 つはつないでいない = 読んでもやめる）
    await enqueueNotice(deps.db, "shop-b", "o-b", "received", NOW - 2);
    await enqueueNotice(deps.db, "shop-c", "o-c", "received", NOW - 1);
    await enqueueNotice(deps.db, SHOP, ORDER, "received", NOW);
    let queries = 0;
    const db = deps.db;
    const counted: Deps = { ...deps, db: { all: (q, p) => (queries++, db.all(q, p)), first: (q, p) => (queries++, db.first(q, p)), run: (q, p) => (queries++, db.run(q, p)), batch: (x) => (queries++, db.batch(x)) } };
    await processNotices(counted, NOTICE_BUDGET, { maxQueries: NOTICE_QUERY_BUDGET });
    expect(queries).toBeLessThanOrEqual(NOTICE_QUERY_BUDGET);
    // 1 + 新しいショップ 1 つ（3）+ 1 通（2）= 6。次のショップの分（5）は上限を超えるので、残りの 2 通は次の回に
    expect(await deps.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM notice_sends WHERE status = 'pending' AND attempts = 0`)).toEqual({ n: 2 });
  });

  it("送り手の設定の誤り（Resend の 401・403、SMTP の認証）は失敗にせず、やり直しを待つ", async () => {
    expect(permanentMailError("resend", 403)).toBe(false);
    expect(permanentMailError("resend", 401)).toBe(false);
    expect(permanentMailError("resend", 422)).toBe(true);
    expect(permanentMailError("smtp", 535)).toBe(false);
    expect(permanentMailError("smtp", 550)).toBe(true);
    expect(permanentMailError("smtp", 451)).toBe(false);
    const b = banto({ mailFail: 1, mailStatus: 403 });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    expect((await sends(deps))[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("失敗した知らせ（7 日以内）をまとめて送り直せる", async () => {
    const b = banto({ mailFail: 1, mailStatus: 422 });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    await enqueueNotice(deps.db, SHOP, "old-order", "shipped", NOW - 8 * 86400);
    await deps.db.run(`UPDATE notice_sends SET status = 'failed' WHERE order_id = 'old-order'`);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const page = await (await app.fetch(new Request(`${ORIGIN}/admin/notices?s=${encodeURIComponent(s)}&status=failed`), deps)).text();
    expect(page).toContain("失敗した 1 件をまとめて送り直す");
    const r = await app.fetch(new Request(`${ORIGIN}/admin/notices/retry-failed`, { method: "POST", body: new URLSearchParams({ s }), headers: { Origin: ORIGIN } }), deps);
    expect(r.status).toBe(303);
    expect((await deps.db.all<{ order_id: string; status: string }>(`SELECT order_id, status FROM notice_sends ORDER BY order_id`)).map((x) => [x.order_id, x.status])).toEqual([
      ["o0000000-0000-4000-8000-000000000001", "pending"],
      ["old-order", "failed"],
    ]);
  });

  it("エラーの文のアドレスは , ; を含んでも丸ごと消す", () => {
    expect(redactAddresses("invalid mail address: taro.yamada,work@example.com")).toBe("invalid mail address: <address>");
    expect(redactAddresses("550 5.1.1 <a;b@example.jp>: rejected")).toBe("550 5.1.1 <address> rejected");
  });

  it("受け取りの応答の後すぐに送る（Cron を待たない）", async () => {
    const b = banto();
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => undefined, props: {} };
    const body = JSON.stringify({ id: "d1", event: "order.paid", created_at: new Date(NOW * 1000).toISOString(), shop_id: SHOP, attempt: 1, data: { order_id: ORDER, shop_id: SHOP } });
    const res = await app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps, ctx);
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(b.seen).toHaveLength(1);
    expect((await sends(deps))[0]).toMatchObject({ status: "done" });
  });
});

describe("Banto 0172・0173 に合わせる", () => {
  it("orders:contact だけのつなぎ方でも宛先を読んで送り、住所は求めない", async () => {
    const contactOnly = orderJson(true, { customer: { name: "佐藤 一郎", email: "guest@example.com", phone: "0312345678", prefecture: "東京都" } });
    const b = banto({ order: contactOnly });
    const deps = await setup(b, ["orders:read", "orders:contact"]);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    expect((b.seen[0]!.body as Record<string, unknown>)["to"]).toEqual(["guest@example.com"]);
    // 準備の確かめも orders:contact で通る
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const page = await (await app.fetch(new Request(`${ORIGIN}/admin/notices?s=${encodeURIComponent(s)}`), deps)).text();
    expect(page).not.toContain("宛先を読む権限");
  });

  it("発送の知らせに運送会社・お問い合わせ番号・追跡のリンクを書く。番号が無ければ確認ページを案内する", async () => {
    const withTracking = orderJson(true, { tracking: { carrier: "yamato", carrier_label: "ヤマト運輸", number: "123456789012", url: "https://toi.kuronekoyamato.co.jp/x?n=1" } });
    const b = banto({ order: withTracking });
    const deps = await setup(b);
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("shipped"), enabled: true, format: "html", body: DEFAULT_HTML.shipped }, NOW);
    await hook(deps, "d1", "order.shipped", {});
    await processNotices(deps, 10);
    const m = b.seen[0]!.body as Record<string, string>;
    expect(m["html"]).toContain("お問い合わせ番号: <strong>123456789012</strong>");
    expect(m["html"]).toContain('href="https://toi.kuronekoyamato.co.jp/x?n=1"');
    expect(m["text"]).toContain("配送: ヤマト運輸\nお問い合わせ番号: 123456789012\n配送の状況: https://toi.kuronekoyamato.co.jp/x?n=1");

    const b2 = banto({ order: orderJson(true, { tracking: null }) });
    const deps2 = await setup(b2);
    await saveTemplate(deps2.db, SHOP, { ...defaultTemplate("shipped"), enabled: true }, NOW);
    await hook(deps2, "d1", "order.shipped", {});
    await processNotices(deps2, 10);
    expect(String((b2.seen[0]!.body as Record<string, unknown>)["text"])).toContain(`お問い合わせ番号は、ご注文の確認ページでご覧いただけます。\n${BANTO}/my-shop/orders/lookup?banto_order=1042`);
  });
});

describe("画面", () => {
  const post = (deps: Deps, path: string, o: Record<string, string>) => app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: new URLSearchParams(o), headers: { Origin: ORIGIN } }), deps);

  it("準備がそろうまで「手代が送る」にできず、そろえば保存して見本を出す", async () => {
    const deps = await setup(banto(), ["orders:read"]);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const list = await (await app.fetch(new Request(`${ORIGIN}/admin/notices?s=${encodeURIComponent(s)}`), deps)).text();
    expect(list).toContain("orders:contact");
    expect(list).toContain("ログインのコード");
    const t = defaultTemplate("received");
    const bad = await post(deps, "/admin/notices/save", { s, op: "save", kind: "received", enabled: "1", format: "text", subject: t.subject, body: t.body });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("そろうまで");

    const deps2 = await setup(banto());
    const ok = await post(deps2, "/admin/notices/save", { s, op: "save", kind: "received", enabled: "1", format: "html", subject: t.subject, body: DEFAULT_HTML.received });
    expect(ok.status).toBe(303);
    const edit = await (await app.fetch(new Request(`${ORIGIN}/admin/notices/received?s=${encodeURIComponent(s)}`), deps2)).text();
    expect(edit).toContain('class="mail-preview"');
    expect(edit).toContain("リネンシャツ");
    const missing = await post(deps2, "/admin/notices/save", { s, op: "save", kind: "received", format: "text", subject: "x", body: "ありがとう" });
    expect(await missing.text()).toContain("{{order_details}} を必ず入れて");
  });

  it("試しに送る: 画面の文面を見本の注文で運営者の宛先に送り、保存はしない。30 秒に 1 通まで", async () => {
    const b = banto();
    const deps = await setup(b);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const form = { s, op: "test", kind: "received", format: "html", subject: "{{shop}} ご注文 {{order_number}}", body: DEFAULT_HTML.received };
    // 運営者の宛先が無ければ送らない
    const noTo = await post(deps, "/admin/notices/save", form);
    expect(noTo.status).toBe(400);
    expect(await noTo.text()).toContain("運営者への知らせ");
    expect(b.seen).toHaveLength(0);

    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <order@shop.example>", operator_email: "owner@shop.example" }, NOW);
    const ok = await post(deps, "/admin/notices/save", form);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("試しに送りました");
    expect(b.seen).toHaveLength(1);
    const m = b.seen[0]!.body as Record<string, unknown>;
    expect(m["to"]).toEqual(["owner@shop.example"]);
    expect(m["subject"]).toBe("[試し送り] テストの店 ご注文 1001");
    expect(String(m["html"])).toContain("リネンシャツ");
    // 保存はしていない（Banto の注文も読まない）
    expect(await deps.db.all(`SELECT kind FROM notice_templates`)).toEqual([]);
    expect(deps.calls.some((r) => r.url.includes("/api/v1/orders/"))).toBe(false);

    const again = await post(deps, "/admin/notices/save", form);
    expect(await again.text()).toContain("30 秒に 1 通");
    expect(b.seen).toHaveLength(1);
    const later = { ...deps, now: () => NOW + 31 };
    await post(later, "/admin/notices/save", form);
    expect(b.seen).toHaveLength(2);

    // 文面に誤りがあれば送らない
    const bad = await post({ ...deps, now: () => NOW + 100 }, "/admin/notices/save", { ...form, body: "明細なし" });
    expect(await bad.text()).toContain("{{order_details}} を必ず入れて");
    expect(b.seen).toHaveLength(2);
  });

  it("SMTP: 送り始める前に印を残し、印の残った行（送っている途中で切れた）は取り直しても送り直さない", async () => {
    const deps = await setup(banto());
    deps.config.mail = { transport: "smtp", host: "mail.example", port: 465, tls: "on" };
    let connects = 0;
    let marked: unknown = null;
    deps.sockets = {
      connect: async () => {
        connects++;
        marked = (await deps.db.first<{ sending_at: number | null }>(`SELECT sending_at FROM notice_sends`))!.sending_at;
        throw new Error("down");
      },
    };
    await saveTemplate(deps.db, SHOP, { ...defaultTemplate("received"), enabled: true }, NOW);
    await hook(deps, "d1", "order.paid", {});
    await processNotices(deps, 10);
    expect(connects).toBe(1);
    expect(marked).toBe(NOW);
    // つながらずに失敗したなら、印は外れてやり直す
    expect(await deps.db.first(`SELECT status, sending_at FROM notice_sends`)).toEqual({ status: "pending", sending_at: null });
    // 送っている途中で切れた（印が残ったまま持ち時間が過ぎた）
    await deps.db.run(`UPDATE notice_sends SET sending_at = ?, due_at = ?`, [NOW, NOW]);
    await processNotices(deps, 10);
    expect(connects).toBe(1);
    expect(await deps.db.first(`SELECT status, result, last_error FROM notice_sends`)).toEqual({ status: "failed", result: "maybe_sent", last_error: "interrupted" });
  });
});
