/**
 * 暗号の部品（WebCrypto だけ。Workers と Node の両方で動く）。
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export function hex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

/** 長さの違いだけは漏れてよい文字列（hex の署名など）の定数時間比較 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 手代の秘密から用途ごとの鍵の材料を作る（同じ秘密を別の用途に使い回さない） */
export function deriveSecret(rootSecret: string, purpose: string): Promise<string> {
  return hmacHex(rootSecret, `tedai:${purpose}`);
}

async function aesKey(rootSecret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`tedai:box:${rootSecret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * 秘密の値（Banto のトークン・署名シークレット）を暗号化する。形は `v1.<iv>.<暗号文>`（base64url）。
 * aad（追加認証データ）に連携と用途を入れ、暗号文を別の行・別の用途に移しても開けないようにする。
 */
export async function seal(rootSecret: string, aad: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(rootSecret), enc.encode(plain));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

/** 開けなければ null（秘密が変わった・aad が違う・壊れている） */
export async function open(rootSecret: string, aad: string, box: string): Promise<string | null> {
  const [v, ivs, cts] = box.split(".");
  if (v !== "v1" || !ivs || !cts) return null;
  const iv = fromB64url(ivs);
  const ct = fromB64url(cts);
  if (!iv || !ct || iv.length !== 12) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(rootSecret), ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}
