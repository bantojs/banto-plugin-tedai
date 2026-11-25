/**
 * 手代の管理画面の作業の券。Banto の banto_ticket（5 分）を確かめたあと、これ（60 分）に替えてリンクとフォームで運ぶ。
 * 画面は Banto の管理画面の iframe（よそのサイト）なので、Cookie はブラウザに捨てられることがある。Cookie には頼らない。
 */
import { b64url, deriveSecret, fromB64url, hmacHex, safeEqual } from "../crypto";

export interface AdminSession {
  shop_id: string;
  endpoint_id: string;
  user_id: string;
  exp: number;
}

export const SESSION_SECONDS = 3600;

export async function signSession(rootSecret: string, s: Omit<AdminSession, "exp">, now: number): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ ...s, exp: now + SESSION_SECONDS })));
  return `${body}.${await hmacHex(await deriveSecret(rootSecret, "admin-session"), body)}`;
}

export async function verifySession(rootSecret: string, token: string, now: number): Promise<AdminSession | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 1000) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!safeEqual(await hmacHex(await deriveSecret(rootSecret, "admin-session"), body), sig)) return null;
  const raw = fromB64url(body);
  if (!raw) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (typeof c["shop_id"] !== "string" || typeof c["endpoint_id"] !== "string" || typeof c["user_id"] !== "string" || typeof c["exp"] !== "number") return null;
    if (c["exp"] < now) return null;
    return { shop_id: c["shop_id"], endpoint_id: c["endpoint_id"], user_id: c["user_id"], exp: c["exp"] };
  } catch {
    return null;
  }
}
