import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { BudgetExceeded, createBudget } from "../src/budget";
import { mailer } from "../src/mail/transport";
import { createApp } from "../src/app";
import { parseActionsForm, type Actions } from "../src/rules/actions";
import type { Condition } from "../src/rules/condition";
import { onOrderPaid, runId } from "../src/rules/trigger";
import { processRuns } from "../src/runs/execute";
import { buildMimeMessage } from "../src/mail/message";
import { SmtpMaybeSent, smtpSend } from "../src/mail/smtp-client";
import type { RawConnection, SocketAdapter } from "../src/mail/socket";
import { recordOrder } from "../src/store/purchases";
import { addSetItems, createSet, saveRule } from "../src/store/rules";
import { EMPTY_SETTINGS, saveSettings, setKv, SELF_ORIGIN } from "../src/store/settings";
import { unsubscribeToken } from "../src/unsubscribe";
import type { Deps } from "../src/deps";
import { BANTO, NOW, SECRET, SHOP, TOKEN, exchangeRoute, makeDeps, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const CUST = "c0000000-0000-4000-8000-000000000001";
const ctxAll = { mailTransport: true, mailSettings: true, operatorEmail: true, slack: true };

describe("アクションの形", () => {
  it("差し込み・手段・送り手の決まりを確かめる", () => {
    const base = { message_on: "1", channel: "line_then_email", line_text: "{{name}} さん", email_subject: "お知らせ", email_body: "本文" };
    expect(parseActionsForm(base, ctxAll).errors).toEqual([]);
    expect(parseActionsForm({ ...base, line_text: "{{coupon_code}}" }, ctxAll).errors.join()).toContain("クーポンを配るアクション");
    expect(parseActionsForm({ ...base, line_text: "{{email}}" }, ctxAll).errors.join()).toContain("知らない差し込み");
    expect(parseActionsForm(base, { ...ctxAll, mailSettings: false }).errors.join()).toContain("特定電子メール法");
    expect(parseActionsForm({ ...base, channel: "line" }, { ...ctxAll, mailTransport: false, mailSettings: false }).errors).toEqual([]);
    expect(parseActionsForm({ ...base, line_button_label: "見る" }, ctxAll).errors.join()).toContain("両方");
    expect(parseActionsForm({ attr_on: "1", attr_key: "Bad Key" }, ctxAll).errors.join()).toContain("キー");
    expect(parseActionsForm({ tags_on: "1", order_tags: "a, b、c" }, ctxAll).actions.order_tags).toEqual(["a", "b", "c"]);
  });
});

/** 偽の Banto・Resend・Slack。来た要求を順に残す */
function services(opts: { line?: string; consent?: boolean | null; lineFail?: number; attrStatus?: number } = {}) {
  const seen: { method: string; url: string; body: unknown; headers: Headers }[] = [];
  let lineFails = opts.lineFail ?? 0;
  const route: Route = async (req) => {
    const u = new URL(req.url);
    const body = req.method === "GET" ? null : await req.clone().json().catch(() => null);
    seen.push({ method: req.method, url: u.origin + u.pathname, body, headers: req.headers });
    if (u.origin === "https://api.resend.com") return Response.json({ id: "m1" });
    if (u.origin === "https://hooks.slack.com") return new Response("ok");
    if (u.origin !== BANTO) return undefined;
    if (u.pathname.startsWith("/api/v1/")) expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    if (req.method === "GET" && u.pathname === `/api/v1/customers/${CUST}`)
      return Response.json({ id: CUST, name: "山田 花子", email: "hanako@example.com", marketing_consent: opts.consent === undefined ? true : opts.consent });
    if (req.method === "PATCH" && u.pathname === `/api/v1/customers/${CUST}`) return opts.attrStatus ? Response.json({ error: { code: "invalid_field_x" } }, { status: opts.attrStatus }) : Response.json({ id: CUST });
    if (req.method === "PATCH" && u.pathname === "/api/v1/orders/o1") return Response.json({ id: "o1" });
    if (req.method === "POST" && u.pathname === "/api/v1/coupons/cp1/grants") return Response.json({ issued: 1, skipped: 0, grants: [{ id: "g1", code: "AKI-777", customer_id: CUST }] }, { status: 201 });
    if (req.method === "POST" && u.pathname === `/api/v1/customers/${CUST}/line-message`) {
      if (lineFails > 0) {
        lineFails--;
        return Response.json({ error: { code: "line_error" } }, { status: 502 });
      }
      return Response.json({ id: "l1", status: opts.line ?? "sent" });
    }
    return undefined;
  };
  return { route, seen };
}

const cond = (setId: string): Condition => ({ purchase: { set_id: setId, mode: "all_in_one_order", n: 1, days: null }, orders_at_least: null, spend_at_least: null });

const fullActions: Actions = {
  attribute: { key: "segment", value: "vip" },
  order_tags: ["同梱物あり"],
  coupon_id: "cp1",
  message: {
    channel: "line_then_email",
    line_text: "{{name}} さん、{{coupon_code}} をどうぞ",
    line_image_url: null,
    line_button_label: null,
    line_button_url: null,
    email_subject: "{{shop}} からのお礼",
    email_body: "{{name}} さん\nクーポン {{coupon_code}}",
  },
  notify_slack: true,
  notify_email: false,
  wait_days: 0,
  recheck: true,
};

async function setup(svc: ReturnType<typeof services>, actions: Actions, status: "active" | "record_only" = "active") {
  const deps = makeDeps([exchangeRoute, svc.route]);
  deps.config.mail = { transport: "resend", apiKey: "re_test" };
  deps.config.slackWebhookUrl = "https://hooks.slack.com/services/T000/B000/XXXX";
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  await setKv(deps.db, SELF_ORIGIN, ORIGIN);
  await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <news@shop.example>", reply_to: "", sender_name: "株式会社テスト", sender_address: "東京都千代田区 1-1", sender_contact: "info@shop.example", operator_email: "" }, NOW);
  const setId = (await createSet(deps.db, SHOP, "セット", NOW)) as string;
  await addSetItems(deps.db, SHOP, setId, [{ product_id: "A", product_name: "A", product_slug: "a" }], NOW);
  const ruleId = (await saveRule(deps.db, SHOP, { id: null, name: "お礼", status, condition: cond(setId), actions }, NOW)) as string;
  await recordOrder(deps.db, SHOP, { order_id: "o1", customer_id: CUST, total_jpy: 1000, ordered_at: NOW, cancelled: false, items: [{ product_id: "A", qty: 1, unit_price_jpy: 1000 }], banto_updated_at: null, complete: true });
  await onOrderPaid(deps.db, SHOP, CUST, "o1", NOW);
  return { deps, ruleId };
}

const banto = (svc: ReturnType<typeof services>) => svc.seen.filter((x) => x.url.startsWith(BANTO)).map((x) => `${x.method} ${x.url.slice(BANTO.length)}`);

describe("アクションの列", () => {
  it("記録だけのルールは列に積まない", async () => {
    const svc = services();
    const { deps } = await setup(svc, fullActions, "record_only");
    expect(await deps.db.all(`SELECT * FROM runs`)).toHaveLength(0);
    expect(await deps.db.all(`SELECT * FROM rule_hits`)).toHaveLength(1);
  });

  it("項目 → 印 → クーポン → LINE → Slack の順に行い、名前とコードを差し込む", async () => {
    const svc = services();
    const { deps, ruleId } = await setup(svc, fullActions);
    expect(await processRuns(deps, 3)).toBe(1);
    expect(banto(svc)).toEqual([
      `GET /api/v1/customers/${CUST}`,
      `PATCH /api/v1/customers/${CUST}`,
      "PATCH /api/v1/orders/o1",
      "POST /api/v1/coupons/cp1/grants",
      `POST /api/v1/customers/${CUST}/line-message`,
    ]);
    const line = svc.seen.find((x) => x.url.endsWith("/line-message"))!;
    expect(line.body).toEqual({ text: "山田 花子 さん、AKI-777 をどうぞ" });
    expect(line.headers.get("Idempotency-Key")).toBe(`tedai-${await runId(ruleId, CUST)}`);
    const slack = svc.seen.find((x) => x.url.startsWith("https://hooks.slack.com"))!;
    expect(JSON.stringify(slack.body)).toContain(CUST);
    expect(JSON.stringify(slack.body)).not.toContain("山田");
    const run = await deps.db.first<{ status: string; steps: string }>(`SELECT status, steps FROM runs`);
    expect(run!.status).toBe("done");
    expect(run!.steps).not.toContain("山田");
    expect(run!.steps).not.toContain("hanako");
  });

  it("LINE が届かなければ、同意のある人にだけメールで送る（送り手の表示と配信停止のリンク付き）", async () => {
    const svc = services({ line: "not_friend" });
    const { deps } = await setup(svc, fullActions);
    await processRuns(deps, 3);
    const mail = svc.seen.find((x) => x.url.startsWith("https://api.resend.com"))!;
    const b = mail.body as Record<string, unknown> & { headers: Record<string, string> };
    expect(b["to"]).toEqual(["hanako@example.com"]);
    expect(b["subject"]).toBe("テストの店 からのお礼");
    expect(String(b["text"])).toContain("クーポン AKI-777");
    expect(String(b["text"])).toContain("株式会社テスト");
    expect(String(b["text"])).toContain(`${ORIGIN}/u/`);
    expect(b.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const steps = JSON.parse((await deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps);
    expect(steps.message).toEqual({ channel: "email", result: "sent", line: "not_friend" });

    const svc2 = services({ line: "no_line", consent: null });
    const r2 = await setup(svc2, fullActions);
    await processRuns(r2.deps, 3);
    expect(svc2.seen.some((x) => x.url.startsWith("https://api.resend.com"))).toBe(false);
    expect(JSON.parse((await r2.deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps).message).toEqual({ channel: "none", result: "no_consent", line: "no_line" });
  });

  it("Cron の上限の手前で止まったら、済んだ手順を残して次の回へ（同じ連絡を 2 度しない）", async () => {
    const svc = services();
    const { deps } = await setup(svc, fullActions);
    // LINE を送った後の通信（Slack）で上限に当たったことにする
    const f = deps.fetch;
    let lineSent = false;
    const limited = { ...deps, fetch: (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (lineSent) throw new BudgetExceeded("total");
      const res = await f(i, init);
      if (String(i).endsWith("/line-message")) lineSent = true;
      return res;
    }) as typeof fetch };
    let rescued = 0;
    await expect(processRuns(limited, 3, { canContinue: () => true, rescue: async (fn) => (rescued++, fn()) })).rejects.toThrow(BudgetExceeded);
    // 止めたときの終わり方だけ（送っている途中の印は、上限の手前の余りを使わずに書く）
    expect(rescued).toBe(1);
    const run = await deps.db.first<{ status: string; attempts: number; steps: string }>(`SELECT status, attempts, steps FROM runs`);
    expect(run).toMatchObject({ status: "pending", attempts: 0 });
    // Slack は始める前に止めたので、送っている途中の印は残さない（次の回に送る）
    expect(JSON.parse(run!.steps).sending).toBeUndefined();
    expect(JSON.parse(run!.steps).message).toMatchObject({ channel: "line", result: "sent" });
    // 次の回: LINE は送り直さず、残り（Slack）だけ
    const before = svc.seen.filter((x) => x.url.endsWith("/line-message")).length;
    await processRuns(deps, 3);
    expect(svc.seen.filter((x) => x.url.endsWith("/line-message")).length).toBe(before);
    expect(svc.seen.some((x) => x.url.startsWith("https://hooks.slack.com"))).toBe(true);
    expect((await deps.db.first<{ status: string }>(`SELECT status FROM runs`))!.status).toBe("done");
  });

  it("送り手が上限の誤りを包まず、止めた後のほかの誤りも上限として扱う（済んだ Slack を 2 度送らない）", async () => {
    // Resend の送り手は、上限で止めた誤りをそのまま投げる
    const m = mailer({ transport: "resend", apiKey: "k" }, { fetch: (() => Promise.reject(new BudgetExceeded("total"))) as typeof fetch, ehloName: "x" });
    await expect(m.send({ from: "a@shop.example", to: "b@example.com", subject: "s", text: "t" })).rejects.toBeInstanceOf(BudgetExceeded);

    const svc = services({ line: "not_friend" });
    const { deps } = await setup(svc, { ...fullActions, message: null, coupon_id: null, notify_slack: true });
    const f = deps.fetch;
    let stopped = false;
    // Slack を送った後、次の通信が「別の形の誤り」で落ちる（上限で止めた後）
    const limited = { ...deps, fetch: (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (stopped) throw new Error("wrapped by something");
      const res = await f(i, init);
      if (String(i).startsWith("https://hooks.slack.com")) stopped = true;
      return res;
    }) as typeof fetch };
    // 運営者へのメールも行う（Slack の後）
    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <news@shop.example>", sender_name: "x", sender_address: "y", sender_contact: "z", operator_email: "owner@shop.example" }, NOW);
    await deps.db.run(`UPDATE rules SET actions = json_set(actions, '$.notify_email', json('true'))`);
    await expect(processRuns(limited, 3, { canContinue: () => true, rescue: (fn) => fn(), stopped: () => stopped })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(JSON.parse((await deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps).slack).toBe("done");
    const slackBefore = svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com")).length;
    await processRuns(deps, 3);
    expect(svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com")).length).toBe(slackBefore);
  });

  it("Cron の上限のどこで止まっても、送った Slack は記録に残り、2 度送らない（本物の数え方で）", async () => {
    for (let k = 20; k <= 46; k++) {
      const svc = services({ line: "not_friend" });
      const { deps } = await setup(svc, { ...fullActions, message: null, coupon_id: null, attribute: null, order_tags: [], notify_slack: true });
      const b = createBudget(deps, "free");
      for (let i = 0; i < k; i++) await deps.db.first(`SELECT 1 AS n`).then(() => b.deps.db.first(`SELECT 1 AS n`)).catch(() => undefined);
      await processRuns(b.deps, 3, { canContinue: () => true, rescue: b.rescue, stopped: () => b.stopped() !== null }).catch(() => undefined);
      const posted = svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com")).length;
      const steps = JSON.parse((await deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps);
      if (posted > 0) expect(steps.slack, `k=${k}`).toBe("done");
      await processRuns(deps, 3);
      expect(svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com")).length, `k=${k}`).toBe(1);
    }
  });

  it("飾りありのメールは、HTML と文字だけの版を両方送る（設定の色・表示・配信停止つき）", async () => {
    const svc = services({ line: "not_friend" });
    const html: Actions = { ...fullActions, message: { ...fullActions.message!, email_format: "html", email_body: "# {{name}} さん\nクーポン **{{coupon_code}}**\n[[お店へ]](https://shop.example)" } };
    const { deps } = await setup(svc, html);
    await processRuns(deps, 3);
    const b = svc.seen.find((x) => x.url.startsWith("https://api.resend.com"))!.body as Record<string, string>;
    expect(b["html"]).toContain("山田 花子 さん");
    expect(b["html"]).toContain("<strong>AKI-777</strong>");
    expect(b["html"]).toContain('href="https://shop.example"');
    expect(b["html"]).toContain("株式会社テスト");
    expect(b["html"]).toContain(`href="${ORIGIN}/u/`);
    expect(b["text"]).toContain("■ 山田 花子 さん");
    expect(b["text"]).toContain(`${ORIGIN}/u/`);
  });

  it("SMTP: 飾りありのメールを、文字だけと HTML の 2 つの部分で送る（通しで）", async () => {
    const svc = services({ line: "not_friend" });
    const html: Actions = { ...fullActions, message: { ...fullActions.message!, email_format: "html", email_body: "# {{name}} さん\nクーポン **{{coupon_code}}**\n.ドットで始まる行\n[[お店へ]](https://shop.example)" } };
    const { deps } = await setup(svc, html);
    deps.config.mail = { transport: "smtp", host: "mail.example", port: 587, tls: "starttls", user: "u", pass: "p" };
    const writes: string[] = [];
    const queue: string[] = ["220 hello\r\n"];
    const reply = (cmd: string) =>
      ({ EHLO: "250-mail.example\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n", STARTTLS: "220 go\r\n", AUTH: "235 ok\r\n", MAIL: "250 ok\r\n", RCPT: "250 ok\r\n", DATA: "354 go\r\n", ".": "250 queued\r\n", QUIT: "221 bye\r\n" })[cmd];
    const conn: RawConnection = {
      async read() {
        const r = queue.shift();
        return r === undefined ? null : new TextEncoder().encode(r);
      },
      async write(d) {
        const line = new TextDecoder().decode(d);
        writes.push(line);
        const r = reply(line.endsWith("\r\n.\r\n") ? "." : line.split(/[ \r]/)[0]!);
        if (r) queue.push(r);
      },
      async startTls() {
        return conn;
      },
      async close() {},
    };
    deps.sockets = { connect: async () => conn };
    await processRuns(deps, 3);
    expect(svc.seen.some((x) => x.url.startsWith("https://api.resend.com"))).toBe(false);
    expect(writes.find((w) => w.startsWith("RCPT"))).toContain("<hanako@example.com>");
    const data = writes.find((w) => w.endsWith("\r\n.\r\n"))!;
    const boundary = /boundary="([^"]+)"/.exec(data)![1]!;
    const parts = data.replace(/\r\n\.\r\n$/, "").split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    const decode = (part: string) => Buffer.from(part.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(parts[1]).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(parts[2]).toContain("Content-Type: text/html; charset=UTF-8");
    const text = decode(parts[1]!);
    const body = decode(parts[2]!);
    expect(text).toContain("■ 山田 花子 さん");
    expect(text).toContain(".ドットで始まる行");
    expect(text).toContain(`${ORIGIN}/u/`);
    expect(body).toContain("<strong>AKI-777</strong>");
    expect(body).toContain('href="https://shop.example"');
    expect(body).toContain("株式会社テスト");
    expect(data).toContain("List-Unsubscribe: <");
    const steps = JSON.parse((await deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps);
    expect(steps.message).toMatchObject({ channel: "email", result: "sent" });
  });

  it("行っている途中で切れ続ける行は、持ち時間の後に取り直し、続けば失敗にして列を止めない", async () => {
    const svc = services();
    const { deps } = await setup(svc, { ...fullActions, message: null, coupon_id: null, attribute: null, notify_slack: false });
    // 4 回取ったまま切れた（回数だけ進み、期限は持ち時間の先）
    await deps.db.run(`UPDATE runs SET attempts = 5, due_at = ?`, [NOW]);
    await processRuns(deps, 3);
    expect(await deps.db.first(`SELECT status, last_error FROM runs`)).toEqual({ status: "failed", last_error: "interrupted" });

    // ふつうに終えた行は回数を元に戻す（取った分を数えない）
    const svc2 = services();
    const r2 = await setup(svc2, { ...fullActions, message: null, coupon_id: null, attribute: null, notify_slack: false });
    await processRuns(r2.deps, 3);
    expect(await r2.deps.db.first(`SELECT status, attempts FROM runs`)).toEqual({ status: "done", attempts: 0 });
  });

  it("Slack を送った直後に済んだ手順を残す（次の手順の前に Worker が切れても、Slack を 2 度送らない）", async () => {
    const svc = services();
    const { deps } = await setup(svc, { ...fullActions, message: null, coupon_id: null, attribute: null, order_tags: [], notify_slack: true, notify_email: true });
    await saveSettings(deps.db, SHOP, { ...EMPTY_SETTINGS, mail_from: "テストの店 <news@shop.example>", operator_email: "owner@shop.example" }, NOW);
    let stepsAtOpMail: string | null = null;
    const f = deps.fetch;
    const watching = { ...deps, fetch: (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).startsWith("https://api.resend.com")) stepsAtOpMail = (await deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps;
      return f(i, init);
    }) as typeof fetch };
    await processRuns(watching, 3);
    expect(JSON.parse(stepsAtOpMail!)).toMatchObject({ slack: "done" });
  });

  it("一時的な失敗はあとでやり直し、済んだ手順はくり返さない", async () => {
    const svc = services({ lineFail: 1 });
    const { deps } = await setup(svc, fullActions);
    await processRuns(deps, 3);
    const r1 = await deps.db.first<{ status: string; attempts: number; due_at: number; last_error: string }>(`SELECT status, attempts, due_at, last_error FROM runs`);
    expect(r1).toMatchObject({ status: "pending", attempts: 1, due_at: NOW + 300 });
    expect(r1!.last_error).toContain("502");
    expect(await processRuns(deps, 3)).toBe(0); // まだ期限が来ていない
    const later = { ...deps, now: () => NOW + 301 };
    await processRuns(later, 3);
    expect((await deps.db.first<{ status: string }>(`SELECT status FROM runs`))!.status).toBe("done");
    expect(svc.seen.filter((x) => x.url.endsWith("/grants"))).toHaveLength(1);
    expect(svc.seen.filter((x) => x.method === "PATCH" && x.url.endsWith(`/customers/${CUST}`))).toHaveLength(1);
  });

  it("頼み方の誤り（400）はやり直さずに失敗にする。ルールを止めたら飛ばす", async () => {
    const svc = services({ attrStatus: 400 });
    const { deps } = await setup(svc, fullActions);
    await processRuns(deps, 3);
    expect(await deps.db.first(`SELECT status, attempts FROM runs`)).toEqual({ status: "failed", attempts: 1 });

    const svc2 = services();
    const r2 = await setup(svc2, fullActions);
    await r2.deps.db.run(`UPDATE rules SET status = 'paused'`);
    await processRuns(r2.deps, 3);
    expect(await r2.deps.db.first(`SELECT status, last_error FROM runs`)).toEqual({ status: "skipped", last_error: "rule_stopped" });
  });
});

describe("配信停止", () => {
  async function connected(svc: ReturnType<typeof services>) {
    const deps = makeDeps([exchangeRoute, svc.route]);
    expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
    await claimOwner(deps.db, SHOP, "u", NOW);
    return deps;
  }
  const consentWrites = (svc: ReturnType<typeof services>) => svc.seen.filter((x) => x.method === "PATCH" && x.url.endsWith(`/customers/${CUST}`)).map((x) => x.body);

  it("GET は確かめるだけ、POST で Banto の同意を取り下げる。ワンクリック（RFC 8058）も", async () => {
    const svc = services();
    const deps: Deps = await connected(svc);
    const tok = await unsubscribeToken(SECRET, SHOP, CUST);
    const get = await app.fetch(new Request(`${ORIGIN}/u/${tok}`), deps);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("配信を止める");
    expect(consentWrites(svc)).toHaveLength(0);
    const post = await app.fetch(new Request(`${ORIGIN}/u/${tok}`, { method: "POST", body: new URLSearchParams({ confirm: "1" }) }), deps);
    expect(await post.text()).toContain("配信を止めました");
    const one = await app.fetch(new Request(`${ORIGIN}/u/${tok}`, { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }), deps);
    expect(one.status).toBe(200);
    expect(consentWrites(svc)).toEqual([{ marketing_consent: false }, { marketing_consent: false }]);
    // RFC 8058 の multipart/form-data でも止める。大きすぎる本文は読まない
    const fd = new FormData();
    fd.set("List-Unsubscribe", "One-Click");
    const multi = await app.fetch(new Request(`${ORIGIN}/u/${tok}`, { method: "POST", body: fd }), deps);
    expect(multi.status).toBe(200);
    expect(consentWrites(svc)).toHaveLength(3);
    const big = await app.fetch(new Request(`${ORIGIN}/u/${tok}`, { method: "POST", body: `List-Unsubscribe=One-Click&x=${"a".repeat(64 * 1024)}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), deps);
    expect(big.status).toBe(413);
  });

  it("書き換えた券は断り、つながっていないショップでは止めたと言わない", async () => {
    const svc = services();
    const deps = await connected(svc);
    const tok = await unsubscribeToken(SECRET, SHOP, CUST);
    const forged = (await unsubscribeToken(SECRET, SHOP, "c0000000-0000-4000-8000-000000000002")).split(".")[0] + "." + tok.split(".")[1];
    expect((await app.fetch(new Request(`${ORIGIN}/u/${forged}`), deps)).status).toBe(400);
    const other = await unsubscribeToken(SECRET, "99999999-9999-4999-8999-999999999999", CUST);
    const r = await app.fetch(new Request(`${ORIGIN}/u/${other}`, { method: "POST", body: new URLSearchParams({ confirm: "1" }) }), deps);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("止められませんでした");
  });
});

describe("メールの形と SMTP", () => {
  it("件名は encoded-word、配信停止のヘッダ、改行の注入を断る", () => {
    const m = buildMimeMessage({ from: "テストの店 <news@shop.example>", to: "a@example.com", subject: "秋の\r\nお知らせ", text: "本文", unsubscribeUrl: "https://t.example/u/x" });
    expect(m.data).toContain("Subject: =?UTF-8?B?");
    expect(m.data).toContain("List-Unsubscribe: <https://t.example/u/x>");
    expect(m.data).not.toContain("秋の\r\n");
    expect(() => buildMimeMessage({ from: "x <news@shop.example>", to: "a@example.com\r\nBcc: b@example.com", subject: "s", text: "t" })).toThrow();
  });

  it("SMTP: 本文を送った後に応答が無ければ、全体の上限で接続を閉じ「送れたかもしれない」とする（断られたら送れていない）", async () => {
    const make = (afterData: "hang" | "554") => {
      let closed = false;
      const queue: string[] = ["220 hello\r\n"];
      let waiter: ((v: Uint8Array | null) => void) | null = null;
      const replies: Record<string, string> = { EHLO: "250 mail.example\r\n", MAIL: "250 ok\r\n", RCPT: "250 ok\r\n", DATA: "354 go\r\n" };
      const conn: RawConnection = {
        read() {
          const r = queue.shift();
          if (r !== undefined) return Promise.resolve(new TextEncoder().encode(r));
          if (closed) return Promise.resolve(null);
          return new Promise((res) => (waiter = res));
        },
        async write(d) {
          const line = new TextDecoder().decode(d);
          if (line.endsWith("\r\n.\r\n")) {
            if (afterData === "554") queue.push("554 rejected\r\n");
            return;
          }
          const r = replies[line.split(/[ \r]/)[0]!];
          if (r) queue.push(r);
        },
        async startTls() {
          return conn;
        },
        async close() {
          closed = true;
          waiter?.(null);
        },
      };
      return { sockets: { connect: async () => conn } as SocketAdapter, closed: () => closed };
    };
    const h = make("hang");
    const msg = buildMimeMessage({ from: "news@shop.example", to: "a@example.com", subject: "s", text: "t" });
    await expect(smtpSend(h.sockets, { host: "m", port: 465, tls: "on", ehloName: "x", timeoutMs: 5000, deadlineMs: 50 }, { from: msg.envelopeFrom, recipients: msg.recipients, data: msg.data })).rejects.toBeInstanceOf(SmtpMaybeSent);
    expect(h.closed()).toBe(true);
    const r = make("554");
    const err = await smtpSend(r.sockets, { host: "m", port: 465, tls: "on", ehloName: "x", timeoutMs: 5000, deadlineMs: 5000 }, { from: msg.envelopeFrom, recipients: msg.recipients, data: msg.data }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SmtpMaybeSent);
    expect((err as { code: number }).code).toBe(554);
  });

  it("SMTP: EHLO → STARTTLS → AUTH → MAIL → RCPT → DATA → QUIT", async () => {
    const sent: string[] = [];
    const replies: Record<string, string> = {
      EHLO: "250-mail.example\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n",
      STARTTLS: "220 go ahead\r\n",
      AUTH: "235 ok\r\n",
      MAIL: "250 ok\r\n",
      RCPT: "250 ok\r\n",
      DATA: "354 go\r\n",
      ".": "250 queued\r\n",
      QUIT: "221 bye\r\n",
    };
    const queue: string[] = ["220 hello\r\n"];
    const conn: RawConnection = {
      async read() {
        const r = queue.shift();
        return r === undefined ? null : new TextEncoder().encode(r);
      },
      async write(d) {
        const line = new TextDecoder().decode(d);
        sent.push(line.split("\r\n")[0]!);
        const cmd = line.endsWith("\r\n.\r\n") ? "." : line.split(/[ \r]/)[0]!;
        if (replies[cmd]) queue.push(replies[cmd]!);
      },
      async startTls() {
        return conn;
      },
      async close() {},
    };
    const sockets: SocketAdapter = { connect: async () => conn };
    const msg = buildMimeMessage({ from: "news@shop.example", to: "a@example.com", subject: "s", text: ".行頭のドット" });
    await smtpSend(sockets, { host: "mail.example", port: 587, tls: "starttls", user: "u", pass: "p", ehloName: "tedai.example" }, { from: msg.envelopeFrom, recipients: msg.recipients, data: msg.data });
    expect(sent.map((l) => l.split(" ")[0])).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA", "From:", "QUIT"]);
  });
});

describe("管理画面のアクションと設定", () => {
  const post = (deps: Deps, path: string, o: Record<string, string>) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: new URLSearchParams(o), headers: { Origin: ORIGIN } }), deps);

  it("設定を確かめて保存し、メールのルールは表示がそろうまで保存させない。見本に差し込みと送り手の表示を出す", async () => {
    const { signSession } = await import("../src/admin/session");
    const { ENDPOINT } = await import("./helpers");
    const coupons: Route = (req) => (new URL(req.url).pathname === "/api/v1/coupons" ? Response.json({ items: [{ id: "cp1", name: "秋の 10%", active: true }] }) : undefined);
    const deps = makeDeps([exchangeRoute, coupons]);
    deps.config.mail = { transport: "resend", apiKey: "re_test" };
    expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
    await claimOwner(deps.db, SHOP, "u", NOW);
    const s = await signSession(SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u" }, NOW);
    const setId = (await createSet(deps.db, SHOP, "セット", NOW)) as string;
    const rule = {
      s,
      op: "save",
      name: "お礼",
      status: "active",
      purchase_on: "1",
      set_id: setId,
      mode: "all_in_one_order",
      message_on: "1",
      channel: "email",
      email_subject: "{{shop}} より",
      email_body: "{{name}} さん、ありがとうございます",
      coupon_on: "1",
      coupon_id: "cp1",
    };
    const blocked = await post(deps, "/admin/rules/save", rule);
    expect(blocked.status).toBe(400);
    expect(await blocked.text()).toContain("特定電子メール法");

    const bad = await post(deps, "/admin/settings", { s, mail_from: "not an address", sender_name: "x" });
    expect(bad.status).toBe(400);
    const ok = await post(deps, "/admin/settings", { s, mail_from: "テストの店 <news@shop.example>", sender_name: "株式会社テスト", sender_address: "東京都", sender_contact: "info@shop.example" });
    expect(ok.status).toBe(303);

    const pv = await post(deps, "/admin/rules/save", { ...rule, op: "preview" });
    const html = await pv.text();
    expect(html).toContain("山田 花子 さん、ありがとうございます");
    expect(html).toContain("株式会社テスト");
    expect(html).toContain("秋の 10%");
    const saved = await post(deps, "/admin/rules/save", rule);
    expect(saved.status).toBe(303);
    const row = await deps.db.first<{ status: string; actions: string }>(`SELECT status, actions FROM rules`);
    expect(row!.status).toBe("active");
    expect(JSON.parse(row!.actions)).toMatchObject({ coupon_id: "cp1", message: { channel: "email", email_subject: "{{shop}} より" } });
    // アクションの無い「動かす」は保存させない
    const none = await post(deps, "/admin/rules/save", { s, op: "save", name: "空", status: "active", purchase_on: "1", set_id: setId, mode: "all_in_one_order" });
    expect(await none.text()).toContain("アクションを 1 つ以上");
  });

  it("SMTP・Slack: 始める前に印を残し、印の残った行（送っている途中で切れた）は送り直さない", async () => {
    const svc = services({ line: "not_friend" });
    const { deps } = await setup(svc, fullActions);
    deps.config.mail = { transport: "smtp", host: "mail.example", port: 465, tls: "on" };
    let connects = 0;
    let marked: unknown = null;
    deps.sockets = {
      connect: async () => {
        connects++;
        marked = JSON.parse((await deps.db.first<{ steps: string }>(`SELECT steps FROM runs`))!.steps).sending;
        throw new Error("down");
      },
    };
    await processRuns(deps, 3);
    expect(connects).toBe(1);
    expect(marked).toBe("message");
    // つながらずに失敗したなら、印は外れてやり直す
    const after = await deps.db.first<{ status: string; steps: string }>(`SELECT status, steps FROM runs`);
    expect(after!.status).toBe("pending");
    expect(JSON.parse(after!.steps).sending).toBeUndefined();
    // 送っている途中で切れた: メールは送れたかもしれないとして送らず、Slack へ進む
    const steps = { ...JSON.parse(after!.steps), sending: "message" };
    await deps.db.run(`UPDATE runs SET steps = ?, due_at = ?`, [JSON.stringify(steps), NOW]);
    await processRuns(deps, 3);
    expect(connects).toBe(1);
    const done = await deps.db.first<{ status: string; steps: string }>(`SELECT status, steps FROM runs`);
    expect(done!.status).toBe("done");
    expect(JSON.parse(done!.steps).message).toMatchObject({ channel: "email", result: "maybe_sent" });
    expect(svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com"))).toHaveLength(1);
    // Slack の途中で切れた行は、Slack を送り直さない
    await deps.db.run(`UPDATE runs SET status = 'pending', steps = ?, due_at = ?`, [JSON.stringify({ ...JSON.parse(done!.steps), slack: undefined, sending: "slack" }), NOW]);
    await processRuns(deps, 3);
    expect(svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com"))).toHaveLength(1);
  });

  it("送っている途中の印を書けなかったら、印を残さずに次の回へ（送っていないものを済みにしない）", async () => {
    const svc = services({ line: "not_friend" });
    const { deps } = await setup(svc, { ...fullActions, message: null });
    const run = deps.db.run.bind(deps.db);
    let fail = true;
    deps.db.run = ((sql: string, params?: Parameters<typeof run>[1]) => {
      if (fail && sql.startsWith("UPDATE runs SET steps") && String(params?.[0]).includes('"sending"')) {
        fail = false;
        return Promise.reject(new Error("d1 busy"));
      }
      return run(sql, params);
    }) as typeof deps.db.run;
    await processRuns(deps, 3);
    const after = await deps.db.first<{ status: string; steps: string }>(`SELECT status, steps FROM runs`);
    expect(after!.status).toBe("pending");
    expect(JSON.parse(after!.steps).sending).toBeUndefined();
    expect(JSON.parse(after!.steps).slack).toBeUndefined();
    expect(svc.seen.some((x) => x.url.startsWith("https://hooks.slack.com"))).toBe(false);
    await deps.db.run(`UPDATE runs SET due_at = ?`, [NOW]);
    await processRuns(deps, 3);
    expect(svc.seen.filter((x) => x.url.startsWith("https://hooks.slack.com"))).toHaveLength(1);
  });
});
