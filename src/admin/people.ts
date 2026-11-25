/**
 * 会員 ID を、運営者に分かる名前とメールの一部にする（画面を描くときだけ Banto から読む。D1 に置かない・ログに出さない）。
 * 1 画面で読むのは max 人まで（Workers の無料プランは外への呼び出しが 1 回 50 まで）。読めなければ ID のまま出す。
 */
import { getCustomer } from "../banto/members";
import type { Deps } from "../deps";

export interface Person {
  name: string | null;
  email: string | null;
}

export type People = Map<string, Person>;

/** メールは頭の 2 文字とドメインだけ（ha***@example.com） */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`;
}

export async function loadPeople(deps: Deps, token: string | null, ids: string[], max = 10): Promise<People> {
  const out: People = new Map();
  if (!token) return out;
  const unique = [...new Set(ids)].slice(0, max);
  const got = await Promise.all(
    unique.map(async (id) => {
      try {
        const c = await getCustomer(deps, token, id);
        return [id, { name: c.name, email: c.email ? maskEmail(c.email) : null }] as const;
      } catch {
        return null;
      }
    }),
  );
  for (const g of got) if (g) out.set(g[0], g[1]);
  return out;
}

