/** 要求の本文を上限つきで読む（Content-Length の無い送り方でも、上限を越えたらそこで読むのをやめる） */

/** 本文を max バイトまで読む。越えたら読むのをやめて null */
export async function readLimited(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) {
    all.set(ch, at);
    at += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** 管理画面のフォームの上限（いちばん大きいフォームでも数十 KB） */
export const MAX_FORM_BYTES = 256 * 1024;

/** 管理画面のフォーム（application/x-www-form-urlencoded）を上限つきで読む。同じ名前が複数あれば配列。越えたら null */
export async function readForm(req: Request): Promise<Record<string, string | string[]> | null> {
  const body = await readLimited(req, MAX_FORM_BYTES);
  if (body === null) return null;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

/**
 * 小さなフォームを上限つきで読む（urlencoded と multipart/form-data の両方。配信停止のワンクリック（RFC 8058）は multipart のこともある）。
 * 文字の欄だけを返す。越えたら null
 */
export async function readSmallForm(req: Request, max = 16 * 1024): Promise<Record<string, string> | null> {
  const body = await readLimited(req, max);
  if (body === null) return null;
  const type = req.headers.get("Content-Type") ?? "";
  const out: Record<string, string> = {};
  if (type.toLowerCase().startsWith("multipart/form-data")) {
    try {
      const fd = await new Response(body, { headers: { "Content-Type": type } }).formData();
      for (const [k, v] of fd) if (typeof v === "string" && !(k in out)) out[k] = v;
    } catch {
      return {};
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(body)) if (!(k in out)) out[k] = v;
  return out;
}
