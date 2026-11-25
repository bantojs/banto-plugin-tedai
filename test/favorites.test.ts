import { claimOwner } from "../src/store/admin-users";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { syncFavorites } from "../src/sync-favorites";
import { ConnectionRepo } from "../src/store/connections";
import type { Deps } from "../src/deps";
import { BANTO, HOOK_SECRET, NOW, SECRET, SHOP, exchangeRoute, makeDeps, signHook, type Route } from "./helpers";

const app = createApp();
const ORIGIN = "https://tedai.example.workers.dev";
const C1 = "c0000000-0000-4000-8000-000000000001";

async function connect(routes: Route[] = []) {
  const deps = makeDeps([exchangeRoute, ...routes]);
  expect((await app.fetch(new Request(`${ORIGIN}/connect?ticket=${"t".repeat(43)}&banto=${encodeURIComponent(BANTO)}`), deps)).status).toBe(200);
  await claimOwner(deps.db, SHOP, "u", NOW);
  return deps;
}

let seq = 0;
async function hook(deps: Deps, event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ id: `f${++seq}`, event, created_at: "2027-01-15T03:00:00Z", shop_id: SHOP, attempt: 1, data: { shop_id: SHOP, ...data } });
  return app.fetch(new Request(`${ORIGIN}/`, { method: "POST", body, headers: { "X-Banto-Signature": await signHook(HOOK_SECRET, body, NOW) } }), deps);
}

describe("お気に入りの hooks", () => {
  it("足した・外したを写し、退会で消す", async () => {
    const deps = await connect();
    await hook(deps, "favorite.added", { customer_id: C1, product_id: "pA" });
    await hook(deps, "favorite.added", { customer_id: C1, product_id: "pB" });
    await hook(deps, "favorite.removed", { customer_id: C1, product_id: "pA" });
    expect(await deps.db.all(`SELECT customer_id, product_id, added_at FROM favorites`)).toEqual([
      { customer_id: C1, product_id: "pB", added_at: Date.parse("2027-01-15T03:00:00Z") / 1000 },
    ]);
    await hook(deps, "customer.deleted", { customer_id: C1 });
    expect(await deps.db.all(`SELECT * FROM favorites`)).toHaveLength(0);
    // 退会した会員のお気に入りは、遅れて届いた hooks でも戻さない
    await hook(deps, "favorite.added", { customer_id: C1, product_id: "pC" });
    expect(await deps.db.all(`SELECT * FROM favorites`)).toHaveLength(0);
  });
  it("まだ使わない出来事（product.updated・inventory.low）は 200 を返し、D1 に書かない", async () => {
    const deps = await connect();
    const r = await hook(deps, "product.updated", { product_id: "pA", slug: "a", name: "A", published: true });
    expect(r.status).toBe(200);
    await hook(deps, "inventory.low", { sku_id: "s1", product_id: "pA", available: 1, threshold: 3 });
    expect(await deps.db.all(`SELECT * FROM hook_deliveries`)).toHaveLength(0);
  });
});

describe("お気に入りの取り込み", () => {
  it("初めは全部、続きは cursor、追いついたら 5 分前から読み直す", async () => {
    const seen: URL[] = [];
    const pages = [
      { items: [{ customer_id: C1, product_id: "pA", product_slug: "a", created_at: "2027-01-01T00:00:00Z" }], has_more: true, cursor: { since: "2027-01-01T00:00:00Z", after: `${C1}:pA` } },
      { items: [{ customer_id: C1, product_id: "pB", product_slug: "b", created_at: "2027-01-02T00:00:00Z" }], has_more: false, cursor: null },
      { items: [], has_more: false, cursor: null },
    ];
    let i = 0;
    const deps = await connect([
      (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/api/v1/favorites") return undefined;
        seen.push(u);
        return new Response(JSON.stringify(pages[Math.min(i++, pages.length - 1)]), { headers: { "Content-Type": "application/json" } });
      },
    ]);
    const conn = (await new ConnectionRepo(deps.db, SECRET).get(SHOP))!;
    expect(await syncFavorites(deps, conn, 5)).toBe(2);
    expect(seen[0]!.searchParams.get("since")).toBeNull();
    expect(seen[1]!.searchParams.get("since")).toBe("2027-01-01T00:00:00Z");
    expect(seen[1]!.searchParams.get("after")).toBe(`${C1}:pA`);
    expect(await deps.db.all(`SELECT product_id FROM favorites ORDER BY product_id`)).toEqual([{ product_id: "pA" }, { product_id: "pB" }]);
    expect(await syncFavorites(deps, conn, 5)).toBe(1);
    expect(seen[2]!.searchParams.get("since")).toBe("2027-01-01T23:55:00.000Z");
    expect(seen[2]!.searchParams.get("after")).toBeNull();
    // 読んだものが無かった回は、読み始めを動かさない
    expect(await deps.db.first(`SELECT since, caught_up FROM favorite_sync`)).toEqual({ since: "2027-01-01T23:55:00.000Z", caught_up: 1 });
  });
});
