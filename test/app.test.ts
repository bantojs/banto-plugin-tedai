import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MIGRATIONS, migrate } from "../src/store/migrations";
import { BANTO, ENDPOINT, HOOK_SECRET, NOW, SECRET, SHOP, TOKEN, exchangeRoute, makeDeps, signHook, signPluginTicket } from "./helpers";
import { ConnectionRepo } from "../src/store/connections";
import type { Deps } from "../src/deps";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const call = (deps: Deps, path: string, init?: RequestInit) => app.fetch(new Request(`${ORIGIN}${path}`, init), deps);

async function connected() {
  const deps = makeDeps([exchangeRoute]);
  const res = await call(deps, `/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}&shop_id=${SHOP}&endpoint_id=${ENDPOINT}`);
  expect(res.status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  return deps;
}

describe("マニフェスト", () => {
  it("JSON を求められたらマニフェスト、それ以外は案内の画面", async () => {
    const deps = makeDeps();
    const m = (await (await call(deps, "/", { headers: { Accept: "application/json" } })).json()) as Record<string, unknown>;
    expect(m["name"]).toBe("手代");
    expect(m["connect_url"]).toBe(`${ORIGIN}/connect`);
    expect(m["admin_url"]).toBe(`${ORIGIN}/admin`);
    expect(m["scopes"]).toContain("line:send");
    expect(m["scopes"]).toContain("orders:contact");
    expect(m["scopes"]).not.toContain("orders:pii");
    expect(m["events"]).toEqual(["order.created", "order.paid", "order.shipped", "order.cancelled", "customer.deleted", "favorite.added", "favorite.removed", "product.updated", "inventory.low", "checkout.abandoned"]);
    const html = await call(deps, "/");
    expect(html.headers.get("Content-Type")).toContain("text/html");
    expect(html.headers.get("Content-Security-Policy")).toContain(`frame-ancestors ${BANTO}`);
  });
});

describe("つなぐ", () => {
  it("券を BANTO_URL の Banto だけで引き換え、トークンとシークレットは暗号化して置く", async () => {
    const deps = await connected();
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]!.url).toBe(`${BANTO}/api/connect/exchange`);
    const rows = await deps.db.all<Record<string, string>>(`SELECT * FROM connections`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain(HOOK_SECRET);
    const repo = new ConnectionRepo(deps.db, SECRET);
    expect(await repo.token(SHOP)).toBe(TOKEN);
    expect((await repo.get(SHOP))?.shop_name).toBe("テストの店");
  });
  it("よその Banto の券は引き換えない", async () => {
    const deps = makeDeps([exchangeRoute]);
    const res = await call(deps, `/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent("https://other.example")}`);
    expect(res.status).toBe(400);
    expect(deps.calls).toHaveLength(0);
  });
  it("引き換えに失敗したら理由を出す", async () => {
    const deps = makeDeps([() => new Response(JSON.stringify({ error: "invalid_ticket" }), { status: 400 })]);
    const res = await call(deps, `/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_ticket");
    expect(await deps.db.all(`SELECT * FROM connections`)).toHaveLength(0);
  });
  it("つなぎ直したら上書きする", async () => {
    const deps = await connected();
    await call(deps, `/connect?ticket=${"u".repeat(43)}&banto=${encodeURIComponent(BANTO)}`);
    expect(await deps.db.all(`SELECT * FROM connections`)).toHaveLength(1);
  });
});

describe("hooks の受け口", () => {
  const envelope = (id: string, event = "favorite.added") =>
    JSON.stringify({ id, event, created_at: "2027-01-15T00:00:00Z", shop_id: SHOP, attempt: 1, data: { shop_id: SHOP, customer_id: "c1", product_id: "p1" } });
  const post = async (deps: Deps, body: string, secret = HOOK_SECRET) =>
    call(deps, "/", { method: "POST", body, headers: { "Content-Type": "application/json", "X-Banto-Signature": await signHook(secret, body, NOW) } });

  it("つないでいないショップは 401（Banto が再送する）", async () => {
    const deps = makeDeps();
    expect((await post(deps, envelope("d1"))).status).toBe(401);
  });
  it("接続ごとのシークレットの署名だけ通し、同じ配信 ID は 1 回だけ処理する", async () => {
    const deps = await connected();
    expect((await post(deps, envelope("d1"), "f".repeat(64))).status).toBe(401);
    const ok = await post(deps, envelope("d1"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    expect(await (await post(deps, envelope("d1"))).text()).toBe("duplicate");
    expect(await deps.db.all(`SELECT * FROM hook_deliveries`)).toHaveLength(1);
  });
  it("形の違う本文は 400", async () => {
    const deps = await connected();
    expect((await post(deps, "not json")).status).toBe(400);
    expect((await post(deps, JSON.stringify({ id: "x" }))).status).toBe(400);
  });
});

describe("管理画面", () => {
  it("banto_ticket を確かめて作業の券に替える。つないだときのコードを入れた人が持ち主で、ほかの人は持ち主が許すまで開けない", async () => {
    const deps = makeDeps([exchangeRoute]);
    const connectPage = async () => {
      const r = await call(deps, `/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`);
      expect(r.status).toBe(200);
      return /<code>([A-Z0-9]{5}-[A-Z0-9]{5})<\/code>/.exec(await r.text())![1]!;
    };
    const code = await connectPage();
    const ticketOf = (user: string) => signPluginTicket(HOOK_SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: user }, NOW);
    const open = async (user: string) => call(deps, `/admin?shop_id=${SHOP}&endpoint_id=${ENDPOINT}&banto_ticket=${await ticketOf(user)}`);
    const claim = async (user: string, c: string, at = NOW) =>
      call({ ...deps, now: () => at } as typeof deps, "/admin/claim", { method: "POST", body: new URLSearchParams({ banto_ticket: await ticketOf(user), shop_id: SHOP, code: c }), headers: { Origin: ORIGIN } });
    // 持ち主がまだいなければ、だれが開いてもコードを求める（先に開いただけでは持ち主にならない）
    const first = await open("u2");
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("持ち主のコードを入れてください");
    expect((await claim("u2", "AAAAA-AAAAA")).status).toBe(400);
    // つないだ人がコードを入れると持ち主（小文字・区切りなしでもよい）
    const res = await claim("u1", code.replace("-", "").toLowerCase(), NOW + 5);
    expect(res.status).toBe(303);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toMatch(/^\/admin\?s=/);
    const page = await call(deps, loc);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("テストの店");
    // 「連携」の項目だけの人は、券があっても開けない（会員の名前などを出さない）
    const other = await open("u2");
    expect(other.status).toBe(403);
    const otherText = await other.text();
    expect(otherText).not.toContain("テストの店");
    expect(otherText).toContain("u2");
    // 持ち主が許すと開ける。外すと、作業の券の期限の前でも使えない
    const s1 = decodeURIComponent(loc.split("s=")[1]!);
    const post = (path: string, user: string) => call(deps, path, { method: "POST", body: new URLSearchParams({ s: s1, user_id: user }), headers: { Origin: ORIGIN } });
    expect((await post("/admin/users/allow", "u2")).status).toBe(303);
    const ok2 = await open("u2");
    expect(ok2.status).toBe(303);
    const loc2 = ok2.headers.get("Location") ?? "";
    expect((await call(deps, loc2)).status).toBe(200);
    await post("/admin/users/remove", "u2");
    expect((await call(deps, loc2)).status).toBe(401);
    // 持ち主でない人は、使える人を変えられない（外された人は、もう一度開こうとしてから許してもらう）
    expect((await open("u2")).status).toBe(403);
    await post("/admin/users/allow", "u2");
    const s2 = decodeURIComponent(((await open("u2")).headers.get("Location") ?? "").split("s=")[1]!);
    const byMember = await call(deps, "/admin/users/allow", { method: "POST", body: new URLSearchParams({ s: s2, user_id: "u3" }), headers: { Origin: ORIGIN } });
    expect(byMember.headers.get("Location")).toContain("msg=owner_only");
    // コードは 1 回限り（もう持ち主がいる）
    expect((await claim("u3", code, NOW + 10)).status).toBe(403);
    // つなぎ直しても持ち主・使える人はそのまま（「連携」の項目でつなぎ直して持ち主を奪えない）。コードも出ない
    const again = await call(deps, `/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`);
    expect(await again.text()).toContain("持ち主と、持ち主が許した人は前のままです");
    expect((await open("u1")).status).toBe(303);
    expect((await open("u9")).status).toBe(403);
    // 持ち主は、許した人に持ち主を移せる
    const s1b = decodeURIComponent(((await open("u1")).headers.get("Location") ?? "").split("s=")[1]!);
    const transfer = await call(deps, "/admin/users/transfer", { method: "POST", body: new URLSearchParams({ s: s1b, user_id: "u2" }), headers: { Origin: ORIGIN } });
    expect(transfer.status).toBe(303);
    expect(await deps.db.all(`SELECT user_id, role FROM admin_users WHERE role IN ('owner', 'member') ORDER BY user_id`)).toEqual([
      { user_id: "u1", role: "member" },
      { user_id: "u2", role: "owner" },
    ]);
  });
  it("別のシークレットの券・期限切れ・つないでいないショップは開けない", async () => {
    const deps = await connected();
    const bad = await signPluginTicket("e".repeat(64), { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u1" }, NOW);
    expect((await call(deps, `/admin?shop_id=${SHOP}&banto_ticket=${bad}`)).status).toBe(401);
    const old = await signPluginTicket(HOOK_SECRET, { shop_id: SHOP, endpoint_id: ENDPOINT, user_id: "u1" }, NOW - 400);
    expect((await call(deps, `/admin?shop_id=${SHOP}&banto_ticket=${old}`)).status).toBe(401);
    expect((await call(deps, `/admin?s=garbage.${"0".repeat(64)}`)).status).toBe(401);
    const other = await call(deps, `/admin?shop_id=33333333-3333-4333-8333-333333333333&banto_ticket=${bad}`);
    expect(await other.text()).toContain("まだつながっていません");
  });
});

describe("表", () => {
  it("2 回当てても壊れない", async () => {
    const deps = makeDeps();
    expect(await migrate(deps.db)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(deps.db)).toEqual([]);
  });
});
