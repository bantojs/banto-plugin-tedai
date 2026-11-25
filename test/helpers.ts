/**
 * テストの道具: SQLite（Node の組み込み node:sqlite）で D1 の代わりをする保存の層と、偽物の Banto。
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlStatement, SqlValue } from "../src/store/sql";
import type { Deps } from "../src/deps";
import { hmacHex } from "../src/crypto";
import { resetMigratedForTest } from "../src/store/migrations";

export function sqliteDb(): SqlDb {
  const db = new DatabaseSync(":memory:");
  const run = (sql: string, params: SqlValue[] = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) });
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async first<T>(sql: string, params: SqlValue[] = []) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, params?: SqlValue[]) {
      return run(sql, params);
    },
    async batch(statements: SqlStatement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => run(s.sql, s.params));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export const BANTO = "https://shop.example.com";
export const SECRET = "0123456789abcdef0123456789abcdef-test";
export const NOW = 1_800_000_000;

export type Route = (req: Request) => Response | Promise<Response | undefined> | undefined;

/** 偽物の Banto。routes で応答を決め、来た要求を calls に残す */
export function fakeFetch(routes: Route[]): { fetch: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = await r(req);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
  return { fetch: f as typeof fetch, calls };
}

export function makeDeps(routes: Route[] = [], now = NOW): Deps & { calls: Request[] } {
  resetMigratedForTest();
  const ff = fakeFetch(routes);
  return { db: sqliteDb(), fetch: ff.fetch, calls: ff.calls, now: () => now, config: { bantoOrigin: BANTO, secret: SECRET, mail: null, mailProblems: [], slackWebhookUrl: null } };
}

/** Banto の src/hooks/signing.ts と同じ計算（送る側） */
export async function signHook(secret: string, body: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

export async function signPluginTicket(secret: string, claims: { shop_id: string; endpoint_id: string; user_id: string }, now: number): Promise<string> {
  const body = btoa(JSON.stringify({ ...claims, exp: now + 300 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${await hmacHex(secret, `banto-plugin-ticket.${body}`)}`;
}

export const SHOP = "11111111-1111-4111-8111-111111111111";
export const ENDPOINT = "22222222-2222-4222-8222-222222222222";
export const HOOK_SECRET = "a".repeat(64);
export const TOKEN = "banto_testtoken_0123456789";

export const exchangeRoute: Route = (req) => {
  if (req.url !== `${BANTO}/api/connect/exchange` || req.method !== "POST") return undefined;
  return new Response(
    JSON.stringify({
      token: TOKEN,
      signing_secret: HOOK_SECRET,
      shop: { id: SHOP, slug: "my-shop", name: "テストの店" },
      endpoint_id: ENDPOINT,
      app: null,
      scopes: ["orders:read", "line:send"],
      api_base: "https://evil.example/api/v1",
      banto_version: "0.10.0",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};
