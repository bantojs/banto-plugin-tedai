import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { claimOwner } from "../src/store/admin-users";
import { processNotices } from "../src/notices/send";
import { checkTemplate, defaultTemplate, DEFAULT_HTML, kindOf, slotsFor } from "../src/notices/kinds";
import { parseMailBody } from "../src/mail/html";
import { saveTemplate } from "../src/store/notices";
import { EMPTY_SETTINGS, saveSettings } from "../src/store/settings";
import type { Deps } from "../src/deps";
import { BANTO, HOOK_SECRET, NOW, SHOP, TOKEN, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const RES = "a0000000-0000-4000-8000-000000000001";
const LINK = `${BANTO}/my-shop/checkout/resume?t=abc`;

const exchangeWith = (scopes: string[]): Route => async (req) => {
  const res = await exchangeRoute(req);
  if (!res) return undefined;
  const j = (await res.json()) as Record<string, unknown>;
  return Response.json({ ...j, scopes });
};

const reminderJson = (contact = true, extra: Record<string, unknown> = {}) => ({
  reservation_id: RES,
  customer_id: "c1",
  created_at: "2026-11-25T06:00:00Z",
  expires_at: "2026-11-28T06:00:00Z",
  total_jpy: 9400,
  pay_until: "11月28日（土）15:00",
  payment_method: "komoju:konbini",
  items: [{ product_name: "リネンシャツ", sku_name: "白 / M", sku_code: "SH-W-M", qty: 1, unit_price_jpy: 8800 }],
  ...(contact ? { email: "buyer@example.com", name: "<b>山田</b> 太郎", payment_link: LINK } : {}),
  ...extra,
});

function banto(opts: { status?: number; contact?: boolean; extra?: Record<string, unknown> } = {}) {
  const seen: { body: Record<string, unknown>; headers: Headers }[] = [];
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === `/api/v1/reservations/${RES}/payment-reminder`) {
      expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      if (opts.status) return Response.json({ error: opts.status === 409 ? "migration_required" : "not_found" }, { status: opts.status });
      return Response.json(reminderJson(opts.contact !== false, opts.extra));
    }
    if (req.url === "https://api.resend.com/emails") {
      seen.push({ body: (await req.json()) as Record<string, unknown>, headers: req.headers });
      return Response.json({ id: "m1" });
    }
    return undefined;
  };
  return { route, seen };
}

async function setup(b: ReturnType<typeof banto>, scopes = ["orders:read", "orders:contact"]) {
  const deps = makeDeps([exchangeWith(scopes), b.route]);
  deps.config.mail = { transport: "resend", apiKey: "re_test" };
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <order@shop.example>", sender_contact: "info@shop.example" }, NOW);
  return deps;
}

const enable = (deps: Deps, format: "text" | "html" = "text") =>
  saveTemplate(deps.db, SHOP, { ...defaultTemplate("payment_reminder"), enabled: true, format, body: format === "html" ? DEFAULT_HTML.payment_reminder : defaultTemplate("payment_reminder").body }, NOW);

const hook = async (deps: Deps, id: string, data: Record<string, unknown> = {}) => {
  const body = JSON.stringify({ id, event: "checkout.payment_pending", created_at: new Date(NOW * 1000).toISOString(), shop_id: SHOP, attempt: 1, data: { reservation_id: RES, shop_id: SHOP, expires_at: "2026-11-28T06:00:00Z", customer_id: "c1", ...data } });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};

const sends = (deps: Deps) => deps.db.all<{ order_id: string; kind: string; status: string; result: string | null }>(`SELECT order_id, kind, status, result FROM notice_sends`);

describe("お支払いのお願い: 種類と文面", () => {
  it("checkout.payment_pending で送る。リンクは必須、注文や試着の差し込みは使えない", () => {
    expect(kindOf("checkout.payment_pending", {})).toBe("payment_reminder");
    expect(checkTemplate(defaultTemplate("payment_reminder"), [])).toEqual([]);
    expect(checkTemplate({ ...defaultTemplate("payment_reminder"), format: "html", body: DEFAULT_HTML.payment_reminder }, parseMailBody(DEFAULT_HTML.payment_reminder, slotsFor("payment_reminder")).errors)).toEqual([]);
    expect(checkTemplate({ ...defaultTemplate("payment_reminder"), body: "{{items}}" }, []).join()).toContain("{{payment_link}}");
    expect(checkTemplate({ ...defaultTemplate("payment_reminder"), body: "{{payment_link}}\n{{order_details}}" }, []).join()).toContain("使えない差し込み");
  });
});

describe("お支払いのお願いを送る", () => {
  it("予約を読んで、リンクつきで送る（宛先とお名前は D1 に置かない）", async () => {
    const b = banto();
    const deps = await setup(b);
    // 送らない設定のあいだは配信 ID も書かない
    await hook(deps, "d0");
    expect(await deps.db.all(`SELECT id FROM hook_deliveries`)).toEqual([]);

    await enable(deps);
    expect((await hook(deps, "d1")).status).toBe(200);
    await hook(deps, "d2");
    expect(await processNotices(deps, 10)).toBe(1);
    expect(b.seen).toHaveLength(1);
    const m = b.seen[0]!.body;
    expect(m["to"]).toEqual(["buyer@example.com"]);
    expect(m["subject"]).toBe("【テストの店】お支払いのお願い（期限 11月28日（土）15:00）");
    expect(String(m["text"])).toContain("<b>山田</b> 太郎 様");
    expect(String(m["text"])).toContain("・リネンシャツ（白 / M） × 1　¥8,800");
    expect(String(m["text"])).toContain("お支払い金額（税込）: ¥9,400");
    expect(String(m["text"])).toContain(LINK);
    expect(b.seen[0]!.headers.get("Idempotency-Key")).toBe(`tedai-n-${SHOP}-${RES}-payment_reminder`);
    expect(await sends(deps)).toEqual([{ order_id: RES, kind: "payment_reminder", status: "done", result: "sent" }]);
    const dump = JSON.stringify(await deps.db.all(`SELECT * FROM notice_sends`));
    expect(dump).not.toContain("buyer@example.com");
    expect(dump).not.toContain("resume?t=");
  });

  it("飾りありはリンクをボタンにし、お名前はエスケープする", async () => {
    const b = banto();
    const deps = await setup(b);
    await enable(deps, "html");
    await hook(deps, "d1");
    await processNotices(deps, 10);
    const m = b.seen[0]!.body as Record<string, string>;
    expect(m["html"]).toContain("&lt;b&gt;山田&lt;/b&gt; 太郎 様");
    expect(m["html"]).toContain(`href="${LINK}"`);
    expect(m["html"]).toContain("お支払いに進む");
    expect(m["html"]).not.toContain("配信を止める");
  });

  it("もう払った・取りやめた予約（404）は送らない。Banto が古ければ失敗にする", async () => {
    const closed = banto({ status: 404 });
    const deps = await setup(closed);
    await enable(deps);
    await hook(deps, "d1");
    await processNotices(deps, 10);
    expect(closed.seen).toHaveLength(0);
    expect((await sends(deps))[0]).toMatchObject({ status: "skipped", result: "reservation_closed" });

    const old = banto({ status: 409 });
    const deps2 = await setup(old);
    await enable(deps2);
    await hook(deps2, "d1");
    await processNotices(deps2, 10);
    expect((await sends(deps2))[0]).toMatchObject({ status: "failed", result: "banto_too_old" });
  });

  it("宛先を読めない・リンクが無いときは送らない", async () => {
    const nocontact = banto({ contact: false });
    const deps = await setup(nocontact, ["orders:read"]);
    await enable(deps);
    await hook(deps, "d1");
    await processNotices(deps, 10);
    expect(nocontact.seen).toHaveLength(0);
    expect((await sends(deps))[0]).toMatchObject({ status: "failed", result: "no_pii" });

    const nolink = banto({ extra: { payment_link: null } });
    const deps2 = await setup(nolink);
    await enable(deps2);
    await hook(deps2, "d1");
    await processNotices(deps2, 10);
    expect(nolink.seen).toHaveLength(0);
    expect((await sends(deps2))[0]).toMatchObject({ status: "failed", result: "no_payment_link" });
  });

  it("「LINE だけ」のお客様にはメールを送らない", async () => {
    const b = banto();
    const deps = await setup(b);
    await enable(deps);
    await hook(deps, "d1", { notice_line_only: true });
    expect(await processNotices(deps, 10)).toBe(0);
    expect(b.seen).toHaveLength(0);
    expect((await sends(deps))[0]).toMatchObject({ status: "skipped", result: "line_only" });
  });
});
