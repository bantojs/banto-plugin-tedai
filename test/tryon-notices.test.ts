import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { claimOwner } from "../src/store/admin-users";
import { processNotices } from "../src/notices/send";
import { checkTemplate, defaultTemplate, DEFAULT_HTML, kindOf, slotsFor, type NoticeKind } from "../src/notices/kinds";
import { parseMailBody } from "../src/mail/html";
import { saveTemplate } from "../src/store/notices";
import { EMPTY_SETTINGS, saveSettings } from "../src/store/settings";
import { dateLabel, parseStoreView, todayJst, tryonSlots, SAMPLE_TRYON } from "../src/notices/tryon";
import type { Deps } from "../src/deps";
import { BANTO, HOOK_SECRET, NOW, SHOP, TOKEN, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const REQ = "r0000000-0000-4000-8000-000000000001";
const STORE = "s0000000-0000-4000-8000-000000000001";

const exchangeWith = (scopes: string[]): Route => async (req) => {
  const res = await exchangeRoute(req);
  if (!res) return undefined;
  const j = (await res.json()) as Record<string, unknown>;
  return Response.json({ ...j, scopes });
};

const tryonJson = (extra: Record<string, unknown> = {}, pii = true) => ({
  id: REQ,
  number: 3007,
  status: "ready",
  store_id: STORE,
  store_name: "渋谷店",
  visit_date: "2026-12-05",
  hold_until: "2026-12-08",
  customer_id: null,
  items: [{ sku_id: "k1", sku_code: "SH-W-M", product_name: "リネンシャツ", sku_name: "白 / M", qty: 1, unit_price_jpy: 8800 }],
  ...(pii ? { customer: { email: "guest@example.com", phone: "090", name: "<b>佐藤</b> 一郎" } } : {}),
  ...extra,
});

const storeJson = {
  id: STORE,
  name: "渋谷店",
  postal_code: "150-0000",
  address: "東京都渋谷区〇〇 1-2-3",
  phone: "03-0000-0000",
  hours: { "0": [["11:00", "19:00"]], "1": [["11:00", "20:00"]], "2": [], "3": [["11:00", "20:00"]], "4": [["11:00", "20:00"]], "5": [["11:00", "20:00"]], "6": [["11:00", "19:00"]] },
  special_days: [{ date: todayJst(NOW), closed: true, hours: [], note: "棚卸し" }],
};

function banto(opts: { tryon?: Record<string, unknown>; pii?: boolean; storesStatus?: number; tryonStatus?: number } = {}) {
  const seen: { body: Record<string, unknown>; headers: Headers }[] = [];
  const paths: string[] = [];
  const route: Route = async (req) => {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/v1/")) paths.push(u.pathname);
    if (u.pathname === "/api/v1/tryon-requests/3007") {
      expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      if (opts.tryonStatus) return Response.json({ error: "not_found" }, { status: opts.tryonStatus });
      return Response.json(tryonJson(opts.tryon, opts.pii !== false));
    }
    if (u.pathname === "/api/v1/stores") {
      if (opts.storesStatus) return Response.json({ error: "forbidden" }, { status: opts.storesStatus });
      return Response.json({ stores: [storeJson] });
    }
    if (req.url === "https://api.resend.com/emails") {
      seen.push({ body: (await req.json()) as Record<string, unknown>, headers: req.headers });
      return Response.json({ id: "m1" });
    }
    return undefined;
  };
  return { route, seen, paths };
}

async function setup(b: ReturnType<typeof banto>, scopes = ["orders:read", "orders:contact", "shop:read"]) {
  const deps = makeDeps([exchangeWith(scopes), b.route]);
  deps.config.mail = { transport: "resend", apiKey: "re_test" };
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <order@shop.example>", sender_contact: "info@shop.example" }, NOW);
  return deps;
}

const enable = (deps: Deps, kind: NoticeKind, format: "text" | "html" = "text") =>
  saveTemplate(deps.db, SHOP, { ...defaultTemplate(kind), enabled: true, format, body: format === "html" ? DEFAULT_HTML[kind] : defaultTemplate(kind).body }, NOW);

const hook = async (deps: Deps, id: string, event: string, data: Record<string, unknown>) => {
  const body = JSON.stringify({ id, event, created_at: new Date(NOW * 1000).toISOString(), shop_id: SHOP, attempt: 1, data: { request_id: REQ, number: 3007, shop_id: SHOP, store_id: STORE, customer_id: null, ...data } });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
};

const sends = (deps: Deps) => deps.db.all<{ order_id: string; kind: string; status: string; result: string | null; order_number: number | null }>(`SELECT order_id, kind, status, result, order_number FROM notice_sends ORDER BY created_at, kind, order_id`);

describe("お店で試着: 出来事 → 知らせの種類", () => {
  it("Banto の同梱プラグインと同じ分け方", () => {
    expect(kindOf("tryon.requested", { status: "requested" })).toBe("tryon_requested");
    expect(kindOf("tryon.updated", { status: "ready" })).toBe("tryon_ready");
    expect(kindOf("tryon.updated", { status: "ready", reminder: true })).toBe("tryon_reminder");
    expect(kindOf("tryon.updated", { status: "ready", extended: true })).toBe("tryon_extended");
    expect(kindOf("tryon.updated", { status: "cancelled" })).toBe("tryon_cancelled");
    for (const status of ["sent", "purchased", "not_purchased", "expired"]) expect(kindOf("tryon.updated", { status })).toBeNull();
  });
});

describe("お店で試着: 文面の確かめ", () => {
  it("既定の文面は通り、品目と店舗の案内（取り置きは期限も）が必須。注文の差し込みは使えない", () => {
    for (const k of ["tryon_requested", "tryon_ready", "tryon_reminder", "tryon_extended", "tryon_cancelled"] as const) {
      expect(checkTemplate(defaultTemplate(k), [])).toEqual([]);
      expect(checkTemplate({ ...defaultTemplate(k), format: "html", body: DEFAULT_HTML[k] }, parseMailBody(DEFAULT_HTML[k], slotsFor(k)).errors)).toEqual([]);
    }
    expect(checkTemplate({ ...defaultTemplate("tryon_ready"), body: "{{tryon_items}}\n{{store_info}}" }, []).join()).toContain("{{hold_until}}");
    expect(checkTemplate({ ...defaultTemplate("tryon_requested"), body: "{{tryon_items}}" }, []).join()).toContain("{{store_info}}");
    expect(checkTemplate({ ...defaultTemplate("tryon_requested"), body: "{{tryon_items}}\n{{store_info}}\n{{order_details}}" }, []).join()).toContain("使えない差し込み");
    expect(checkTemplate({ ...defaultTemplate("received"), body: "{{order_details}}\n{{store_info}}" }, []).join()).toContain("使えない差し込み");
    expect(checkTemplate({ ...defaultTemplate("tryon_ready"), subject: "{{store_info}}" }, []).join()).toContain("件名には使えません");
  });
});

describe("お店で試着: 店舗の案内", () => {
  it("住所・電話・曜日ごとの営業時間・近い臨時休業。権限が無ければ店舗の名前だけ", () => {
    const today = todayJst(NOW);
    const s = tryonSlots(SAMPLE_TRYON, parseStoreView(storeJson), today);
    expect(s["store_info"]!.text).toContain("■ 渋谷店\n〒150-0000 東京都渋谷区〇〇 1-2-3\n電話 03-0000-0000\n営業時間:\n  月 11:00〜20:00\n  火 定休日");
    expect(s["store_info"]!.text).toContain(`${dateLabel(today)} 休業 棚卸し`);
    expect(s["tryon_items"]!.text).toBe("受付番号: 2001\n・リネンシャツ（白 / M） × 1\n・ウールのパンツ（グレー / 76） × 1");
    expect(tryonSlots(SAMPLE_TRYON, null, today)["store_info"]!.text).toBe("■ 渋谷店");
    expect(dateLabel("2026-12-08")).toBe("12月8日（火）");
  });
});

describe("お店で試着のお知らせを送る", () => {
  it("取り置きの知らせを、申し込みと店舗を読んで送る（宛先とお名前は D1 に置かない）", async () => {
    const b = banto();
    const deps = await setup(b);
    // 送らない設定のあいだは配信 ID も書かない
    await hook(deps, "d0", "tryon.updated", { status: "ready", hold_until: "2026-12-08" });
    expect(await deps.db.all(`SELECT id FROM hook_deliveries`)).toEqual([]);

    await enable(deps, "tryon_ready");
    expect((await hook(deps, "d1", "tryon.updated", { status: "ready", hold_until: "2026-12-08" })).status).toBe(200);
    await hook(deps, "d2", "tryon.updated", { status: "ready", hold_until: "2026-12-08" });
    expect(await processNotices(deps, 10)).toBe(1);
    expect(b.seen).toHaveLength(1);
    const m = b.seen[0]!.body;
    expect(m["to"]).toEqual(["guest@example.com"]);
    expect(m["subject"]).toBe("【テストの店】渋谷店でご試着いただけます（受付番号 3007）");
    expect(String(m["text"])).toContain("<b>佐藤</b> 一郎 様");
    expect(String(m["text"])).toContain("12月8日（火）までお取り置きします");
    expect(String(m["text"])).toContain("・リネンシャツ（白 / M） × 1");
    expect(String(m["text"])).toContain("〒150-0000 東京都渋谷区〇〇 1-2-3");
    expect(String(m["text"])).toContain("お問い合わせ: info@shop.example");
    expect(b.seen[0]!.headers.get("Idempotency-Key")).toBe(`tedai-n-${SHOP}-${REQ}-tryon_ready`);
    expect(await sends(deps)).toEqual([{ order_id: REQ, kind: "tryon_ready", status: "done", result: "sent", order_number: 3007 }]);
    const dump = JSON.stringify(await deps.db.all(`SELECT * FROM notice_sends`));
    expect(dump).not.toContain("guest@example.com");
    expect(dump).not.toContain("佐藤");
  });

  it("飾りありは品目と店舗の案内を表にし、お名前はエスケープする", async () => {
    const b = banto({ tryon: { status: "requested", hold_until: null } });
    const deps = await setup(b);
    await enable(deps, "tryon_requested", "html");
    await hook(deps, "d1", "tryon.requested", { status: "requested" });
    await processNotices(deps, 10);
    const m = b.seen[0]!.body as Record<string, string>;
    expect(m["html"]).toContain("&lt;b&gt;佐藤&lt;/b&gt; 一郎 様");
    expect(m["html"]).toContain("ご来店予定日: 12月5日（土）");
    expect(m["html"]).toContain("リネンシャツ（白 / M）");
    expect(m["html"]).toContain("<strong>渋谷店</strong>");
    expect(m["html"]).not.toContain("配信を止める");
    expect(m["text"]).toContain("受付番号: 3007");
  });

  it("延長は延長のたびに 1 通、期限の前日のお知らせは 1 回", async () => {
    const b = banto();
    const deps = await setup(b);
    await enable(deps, "tryon_extended");
    await enable(deps, "tryon_reminder");
    await hook(deps, "d1", "tryon.updated", { status: "ready", extended: true, extend_count: 1, previous_hold_until: "2026-12-05" });
    await hook(deps, "d2", "tryon.updated", { status: "ready", extended: true, extend_count: 2, previous_hold_until: "2026-12-08" });
    await hook(deps, "d3", "tryon.updated", { status: "ready", reminder: true });
    await hook(deps, "d4", "tryon.updated", { status: "ready", reminder: true });
    expect(await processNotices(deps, 10)).toBe(3);
    expect((await sends(deps)).map((r) => [r.kind, r.order_id])).toEqual([
      ["tryon_extended", `${REQ}-e1`],
      ["tryon_extended", `${REQ}-e2`],
      ["tryon_reminder", REQ],
    ]);
  });

  it("積んだ後に取り消された取り置きの知らせは送らない。申し込みが無ければ飛ばす", async () => {
    const b = banto({ tryon: { status: "cancelled" } });
    const deps = await setup(b);
    await enable(deps, "tryon_ready");
    await hook(deps, "d1", "tryon.updated", { status: "ready" });
    await processNotices(deps, 10);
    expect(b.seen).toHaveLength(0);
    expect((await sends(deps))[0]).toMatchObject({ status: "skipped", result: "tryon_changed" });

    const gone = banto({ tryonStatus: 404 });
    const deps2 = await setup(gone);
    await enable(deps2, "tryon_cancelled");
    await hook(deps2, "d1", "tryon.updated", { status: "cancelled" });
    await processNotices(deps2, 10);
    expect((await sends(deps2))[0]).toMatchObject({ status: "skipped", result: "tryon_not_found" });
  });

  it("店舗を読む権限が無いつなぎ方でも、店舗の名前だけで送る。宛先を読めなければ失敗", async () => {
    const b = banto({ storesStatus: 403 });
    const deps = await setup(b, ["orders:read", "orders:contact"]);
    await enable(deps, "tryon_ready");
    await hook(deps, "d1", "tryon.updated", { status: "ready" });
    await processNotices(deps, 10);
    expect(String(b.seen[0]!.body["text"])).toContain("■ 渋谷店");
    expect(String(b.seen[0]!.body["text"])).not.toContain("営業時間:");

    const nopii = banto({ pii: false });
    const deps2 = await setup(nopii, ["orders:read"]);
    await enable(deps2, "tryon_ready");
    await hook(deps2, "d1", "tryon.updated", { status: "ready" });
    await processNotices(deps2, 10);
    expect(nopii.seen).toHaveLength(0);
    expect((await sends(deps2))[0]).toMatchObject({ status: "failed", result: "no_pii" });
  });

  it("受付番号の無い出来事は積まない", async () => {
    const deps = await setup(banto());
    await enable(deps, "tryon_requested");
    await hook(deps, "d1", "tryon.requested", { number: null });
    expect(await sends(deps)).toEqual([]);
  });
});
