/**
 * Banto の口を呼ぶ。行き先はいつも変数 BANTO_URL の Banto だけ（引き換えの応答の api_base も信じない）。
 * トークンはこの中でだけ使い、ログに出さない。
 */
import type { Deps } from "../deps";

export interface ExchangeResult {
  token: string;
  signing_secret: string;
  shop: { id: string; slug: string; name: string };
  endpoint_id: string;
  app: string | null;
  scopes: string[];
  banto_version: string | null;
}

export class BantoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`banto ${status} ${code}`);
  }
}

const TIMEOUT_MS = 8000;

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as Record<string, unknown>;
    const e = j["error"];
    if (typeof e === "string") return e.slice(0, 100);
    if (e && typeof e === "object" && typeof (e as Record<string, unknown>)["code"] === "string") return ((e as Record<string, unknown>)["code"] as string).slice(0, 100);
  } catch {
    // 形が違う
  }
  return "unknown";
}

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** 「つなぐ」の券を引き換える（Banto の docs/hooks.md §6） */
export async function exchangeTicket(deps: Deps, ticket: string): Promise<ExchangeResult> {
  const f = deps.fetch;
  const res = await f(`${deps.config.bantoOrigin}/api/connect/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "banto-plugin-tedai" },
    body: JSON.stringify({ ticket }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new BantoError(res.status, await readError(res));
  const j = (await res.json()) as Record<string, unknown>;
  const shop = j["shop"] && typeof j["shop"] === "object" ? (j["shop"] as Record<string, unknown>) : {};
  const token = str(j["token"], 500);
  const signing_secret = typeof j["signing_secret"] === "string" && /^[0-9a-f]{64}$/.test(j["signing_secret"]) ? j["signing_secret"] : null;
  const shopId = str(shop["id"], 100);
  const endpointId = str(j["endpoint_id"], 100);
  if (!token || !signing_secret || !shopId || !endpointId) throw new BantoError(502, "bad_exchange_response");
  return {
    token,
    signing_secret,
    shop: { id: shopId, slug: str(shop["slug"]) ?? "", name: str(shop["name"]) ?? "" },
    endpoint_id: endpointId,
    app: str(j["app"], 100),
    scopes: Array.isArray(j["scopes"]) ? j["scopes"].filter((s): s is string => typeof s === "string" && s.length <= 50) : [],
    banto_version: str(j["banto_version"], 50),
  };
}

/** AI 用 API（/api/v1）を呼ぶ。2xx 以外は BantoError */
export async function bantoApi<T>(deps: Deps, token: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const f = deps.fetch;
  const res = await f(`${deps.config.bantoOrigin}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "banto-plugin-tedai",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new BantoError(res.status, await readError(res));
  return (await res.json()) as T;
}
