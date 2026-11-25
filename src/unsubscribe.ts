/**
 * 配信停止のリンク。券はショップと会員の ID を手代の秘密で署名したもの（期限なし: 古いメールからでも止められるように）。
 * 押したら Banto に marketing_consent: false を書き戻す（同意の正は Banto）。
 */
import { b64url, deriveSecret, fromB64url, hmacHex, safeEqual } from "./crypto";

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export async function unsubscribeToken(rootSecret: string, shopId: string, customerId: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(`${shopId}.${customerId}`));
  return `${body}.${(await hmacHex(await deriveSecret(rootSecret, "unsubscribe"), body)).slice(0, 32)}`;
}

export async function readUnsubscribeToken(rootSecret: string, token: string): Promise<{ shopId: string; customerId: string } | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || token.length > 400) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(sig)) return null;
  if (!safeEqual((await hmacHex(await deriveSecret(rootSecret, "unsubscribe"), body)).slice(0, 32), sig)) return null;
  const raw = fromB64url(body);
  if (!raw) return null;
  const [shopId, customerId, extra] = new TextDecoder().decode(raw).split(".");
  if (extra !== undefined || !shopId || !customerId || !ID_RE.test(shopId) || !ID_RE.test(customerId)) return null;
  return { shopId, customerId };
}
