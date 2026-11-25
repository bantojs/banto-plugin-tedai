/**
 * Banto との署名の確かめ（Banto の docs/hooks.md §3・§6 と同じ計算）。
 */
import { fromB64url, hmacHex, safeEqual } from "../crypto";

/** hooks の `X-Banto-Signature: t=<秒>,v1=<hex(HMAC-SHA256(secret, `${t}.${body}`))>` を確かめる。5 分より古い・新しいものは断る */
export async function verifyHookSignature(secret: string, body: string, header: string | null, now: number, toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now - Number(t)) > toleranceSeconds) return false;
  return safeEqual(await hmacHex(secret, `${t}.${body}`), v1);
}

export interface PluginTicket {
  shop_id: string;
  endpoint_id: string;
  user_id: string;
  exp: number;
}

/**
 * 管理画面の iframe（admin_url）に付く `banto_ticket` を確かめる。
 * 形: base64url(JSON).hex(HMAC-SHA256(署名シークレット, "banto-plugin-ticket." + base64url 部分))、5 分
 */
export async function verifyPluginTicket(secret: string, ticket: string, now: number): Promise<PluginTicket | null> {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || ticket.length > 2000) return null;
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!safeEqual(await hmacHex(secret, `banto-plugin-ticket.${body}`), sig)) return null;
  const raw = fromB64url(body);
  if (!raw) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  const c = claims as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === "string" && (c[k] as string).length > 0 && (c[k] as string).length <= 100 ? (c[k] as string) : null);
  const shop_id = str("shop_id");
  const endpoint_id = str("endpoint_id");
  const user_id = str("user_id");
  const exp = typeof c["exp"] === "number" ? c["exp"] : NaN;
  if (!shop_id || !endpoint_id || !user_id || !Number.isFinite(exp) || exp < now) return null;
  return { shop_id, endpoint_id, user_id, exp };
}
