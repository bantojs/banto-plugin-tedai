/**
 * つないだショップの行。秘密（トークン・署名シークレット）は箱のまま出し入れし、開けるのは使う直前だけ。
 */
import { open, seal } from "../crypto";
import type { SqlDb } from "./sql";

export interface Connection {
  shop_id: string;
  endpoint_id: string;
  shop_slug: string;
  shop_name: string;
  scopes: string[];
  banto_version: string | null;
  connected_by: string | null;
  connected_at: number;
  updated_at: number;
}

interface Row extends Omit<Connection, "scopes"> {
  scopes: string;
  token_box: string;
  secret_box: string;
}

const tokenAad = (shopId: string, endpointId: string) => `token:${shopId}:${endpointId}`;
const secretAad = (shopId: string, endpointId: string) => `hook-secret:${shopId}:${endpointId}`;

function toConnection(r: Row): Connection {
  let scopes: string[] = [];
  try {
    const v = JSON.parse(r.scopes) as unknown;
    if (Array.isArray(v)) scopes = v.filter((x): x is string => typeof x === "string");
  } catch {
    scopes = [];
  }
  return {
    shop_id: r.shop_id,
    endpoint_id: r.endpoint_id,
    shop_slug: r.shop_slug,
    shop_name: r.shop_name,
    scopes,
    banto_version: r.banto_version,
    connected_by: r.connected_by,
    connected_at: r.connected_at,
    updated_at: r.updated_at,
  };
}

export interface NewConnection {
  shop_id: string;
  endpoint_id: string;
  shop_slug: string;
  shop_name: string;
  scopes: string[];
  banto_version: string | null;
  connected_by: string | null;
  token: string;
  signing_secret: string;
}

/**
 * つないでいないショップの ID（isolate のメモリ。30 秒・1,000 件まで）。つないだら消す。
 * ほかの isolate では最大 30 秒は断るが、Banto は 401 を送り直すので、つないだ後の知らせは届く
 */
const NOT_CONNECTED_MS = 30_000;
const NOT_CONNECTED_MAX = 1000;
const notConnected = new Map<string, number>();
function rememberNotConnected(shopId: string): void {
  if (notConnected.size >= NOT_CONNECTED_MAX) notConnected.clear();
  notConnected.set(shopId, Date.now() + NOT_CONNECTED_MS);
}
/** テスト用 */
export const forgetNotConnected = () => notConnected.clear();

export class ConnectionRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly rootSecret: string,
  ) {}

  /** つないだ・つなぎ直した。同じショップの前の行（前の連携 ID でも）を置き換える */
  async save(c: NewConnection, now: number): Promise<void> {
    notConnected.delete(c.shop_id);
    const tokenBox = await seal(this.rootSecret, tokenAad(c.shop_id, c.endpoint_id), c.token);
    const secretBox = await seal(this.rootSecret, secretAad(c.shop_id, c.endpoint_id), c.signing_secret);
    await this.db.batch([
      // 同じ連携 ID が別のショップの行に残っていれば外す（Banto では起きないが、一意の制約で止まらないように）
      { sql: `DELETE FROM connections WHERE endpoint_id = ? AND shop_id <> ?`, params: [c.endpoint_id, c.shop_id] },
      {
        sql: `INSERT INTO connections (shop_id, endpoint_id, shop_slug, shop_name, scopes, token_box, secret_box, banto_version, connected_by, connected_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(shop_id) DO UPDATE SET endpoint_id = excluded.endpoint_id, shop_slug = excluded.shop_slug, shop_name = excluded.shop_name,
                scopes = excluded.scopes, token_box = excluded.token_box, secret_box = excluded.secret_box, banto_version = excluded.banto_version,
                connected_by = excluded.connected_by, updated_at = excluded.updated_at`,
        params: [c.shop_id, c.endpoint_id, c.shop_slug, c.shop_name, JSON.stringify(c.scopes), tokenBox, secretBox, c.banto_version, c.connected_by, now, now],
      },
    ]);
  }

  async get(shopId: string): Promise<Connection | null> {
    const r = await this.db.first<Row>(`SELECT * FROM connections WHERE shop_id = ?`, [shopId]);
    return r ? toConnection(r) : null;
  }

  async list(): Promise<Connection[]> {
    return (await this.db.all<Row>(`SELECT * FROM connections ORDER BY connected_at`)).map(toConnection);
  }

  /** hooks の署名と管理画面の券を確かめるシークレット。開けなければ null（TEDAI_SECRET が変わった） */
  async signingSecret(shopId: string): Promise<{ connection: Connection; secret: string } | null> {
    // つないでいないショップの ID は、しばらく D1 を読まずに断る（署名を確かめる前に、だれでも送れるため）
    const until = notConnected.get(shopId);
    if (until !== undefined && until > Date.now()) return null;
    const r = await this.db.first<Row>(`SELECT * FROM connections WHERE shop_id = ?`, [shopId]);
    if (!r) {
      rememberNotConnected(shopId);
      return null;
    }
    const secret = await open(this.rootSecret, secretAad(r.shop_id, r.endpoint_id), r.secret_box);
    return secret ? { connection: toConnection(r), secret } : null;
  }

  /** 接続とトークンを 1 回の読み取りで（Cron の D1 の問い合わせを減らすため）。トークンを開けなければ token は null */
  async getWithToken(shopId: string): Promise<{ connection: Connection; token: string | null } | null> {
    const r = await this.db.first<Row>(`SELECT * FROM connections WHERE shop_id = ?`, [shopId]);
    if (!r) return null;
    return { connection: toConnection(r), token: await open(this.rootSecret, tokenAad(r.shop_id, r.endpoint_id), r.token_box) };
  }

  /** Banto の AI 用 API のトークン。開けなければ null */
  async token(shopId: string): Promise<string | null> {
    const r = await this.db.first<Row>(`SELECT * FROM connections WHERE shop_id = ?`, [shopId]);
    if (!r) return null;
    return open(this.rootSecret, tokenAad(r.shop_id, r.endpoint_id), r.token_box);
  }
}
