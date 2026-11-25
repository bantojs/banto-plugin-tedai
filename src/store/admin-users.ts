/**
 * 手代の画面を使える人。Banto は手代の画面の券（banto_ticket）を、ショップの「連携」の項目を持つ人なら誰にでも出す。
 * 手代は「つないだ人」の権限のトークンで動くので、券を持つだけの人に画面（会員の名前・ルール・送り手の設定）を使わせない。
 * Banto の引き換えの応答には「誰がつないだか」が無いので、つないだときに「つなぎました」の画面（つないだ人のブラウザだけに出る）に
 * 1 回限りのコードを出し、そのコードを入れた人を owner にする。owner がいるあいだは、つなぎ直しても owner と member はそのまま
 * （Banto では「連携」の項目があればだれでもつなぎ直せるので、つなぎ直しで owner を奪えないように）。owner は member に owner を移せる。
 * ほかの人は owner が許した人（member）だけ。開こうとした人は pending として owner の画面に並べる。
 */
import { safeEqual, sha256Hex } from "../crypto";
import type { SqlDb } from "./sql";

export type AdminRole = "owner" | "member" | "pending";

const PENDING_KEEP = 20;

export async function roleOf(db: SqlDb, shopId: string, userId: string): Promise<AdminRole | null> {
  const r = await db.first<{ role: string }>(`SELECT role FROM admin_users WHERE shop_id = ? AND user_id = ?`, [shopId, userId]);
  return r && (r.role === "owner" || r.role === "member" || r.role === "pending") ? r.role : null;
}

export async function hasOwner(db: SqlDb, shopId: string): Promise<boolean> {
  return !!(await db.first(`SELECT 1 AS x FROM admin_users WHERE shop_id = ? AND role = 'owner'`, [shopId]));
}

/** owner にする（まだいないときだけ。同時に 2 人が来ても 1 人だけ）。なれたら true */
export async function claimOwner(db: SqlDb, shopId: string, userId: string, now: number): Promise<boolean> {
  await db.run(
    `INSERT INTO admin_users (shop_id, user_id, role, at) SELECT ?, ?, 'owner', ? WHERE NOT EXISTS (SELECT 1 FROM admin_users WHERE shop_id = ? AND role = 'owner')
     ON CONFLICT(shop_id, user_id) DO UPDATE SET role = 'owner', at = excluded.at WHERE NOT EXISTS (SELECT 1 FROM admin_users WHERE shop_id = excluded.shop_id AND role = 'owner')`,
    [shopId, userId, now, shopId],
  );
  return (await roleOf(db, shopId, userId)) === "owner";
}

/**
 * 券で開いた人を通すか。owner か member なら通す。owner がまだいなければ "unclaimed"（コードで owner になってもらう）。
 * owner がいて許されていなければ pending に残す
 */
export async function admit(db: SqlDb, shopId: string, userId: string, now: number): Promise<AdminRole | "unclaimed"> {
  const role = await roleOf(db, shopId, userId);
  if (role === "owner" || role === "member") return role;
  if (!(await hasOwner(db, shopId))) return "unclaimed";
  await db.batch([
    { sql: `INSERT INTO admin_users (shop_id, user_id, role, at) VALUES (?, ?, 'pending', ?) ON CONFLICT(shop_id, user_id) DO UPDATE SET at = excluded.at WHERE admin_users.role = 'pending'`, params: [shopId, userId, now] },
    {
      sql: `DELETE FROM admin_users WHERE shop_id = ? AND role = 'pending' AND user_id NOT IN (SELECT user_id FROM admin_users WHERE shop_id = ? AND role = 'pending' ORDER BY at DESC LIMIT ?)`,
      params: [shopId, shopId, PENDING_KEEP],
    },
  ]);
  return "pending";
}

export async function listAdminUsers(db: SqlDb, shopId: string): Promise<{ user_id: string; role: AdminRole; at: number }[]> {
  return db.all(`SELECT user_id, role, at FROM admin_users WHERE shop_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, at DESC`, [shopId]);
}

/** owner が開こうとした人を許す */
export async function allowUser(db: SqlDb, shopId: string, userId: string, now: number): Promise<boolean> {
  return (await db.run(`UPDATE admin_users SET role = 'member', at = ? WHERE shop_id = ? AND user_id = ? AND role = 'pending'`, [now, shopId, userId])).changes > 0;
}

/** owner が許した人（か開こうとした人）を外す。owner は外せない（つなぎ直すと空に戻る） */
export async function removeUser(db: SqlDb, shopId: string, userId: string, _now?: number): Promise<boolean> {
  return (await db.run(`DELETE FROM admin_users WHERE shop_id = ? AND user_id = ? AND role <> 'owner'`, [shopId, userId])).changes > 0;
}

/** owner が member に owner を移す（移した人は member になる）。移せたら true */
export async function transferOwner(db: SqlDb, shopId: string, fromUser: string, toUser: string, now: number): Promise<boolean> {
  // 1 つの取引で、それぞれの書き込みが前の結果を確かめる（2 つのタブで同時に移しても、持ち主が 2 人や 0 人にならない）
  await db.batch([
    {
      sql: `UPDATE admin_users SET role = 'owner', at = ? WHERE shop_id = ? AND user_id = ? AND role = 'member'
            AND EXISTS (SELECT 1 FROM admin_users WHERE shop_id = ? AND user_id = ? AND role = 'owner')`,
      params: [now, shopId, toUser, shopId, fromUser],
    },
    {
      sql: `UPDATE admin_users SET role = 'member', at = ? WHERE shop_id = ? AND user_id = ? AND role = 'owner'
            AND EXISTS (SELECT 1 FROM admin_users WHERE shop_id = ? AND user_id = ? AND role = 'owner')`,
      params: [now, shopId, fromUser, shopId, toUser],
    },
  ]);
  return (await roleOf(db, shopId, toUser)) === "owner" && (await roleOf(db, shopId, fromUser)) === "member";
}

/** 持ち主になるためのコードの有効な間（秒） */
export const CLAIM_SECONDS = 86400;
const claimKey = (shopId: string) => `owner_claim:${shopId}`;
const CLAIM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 持ち主がいないときに、使える人を空に戻し、持ち主になるための 1 回限りのコードを作る（コードは返すだけで、ハッシュだけを置く） */
export async function resetAdminUsers(db: SqlDb, shopId: string, now: number): Promise<string | null> {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = [...bytes].map((b) => CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]).join("");
  // 持ち主がいないときだけ（確かめと書き込みを 1 つの取引で。そのあいだにコードで持ち主になった人を消さない）
  const noOwner = `NOT EXISTS (SELECT 1 FROM admin_users WHERE shop_id = ? AND role = 'owner')`;
  const r = await db.batch([
    { sql: `DELETE FROM admin_users WHERE shop_id = ? AND ${noOwner}`, params: [shopId, shopId] },
    {
      sql: `INSERT INTO kv (key, value) SELECT ?, ? WHERE ${noOwner} ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      params: [claimKey(shopId), JSON.stringify({ hash: await sha256Hex(`${shopId}:${code}`), exp: now + CLAIM_SECONDS }), shopId],
    },
  ]);
  return r[1]!.changes > 0 ? code : null;
}

/** 画面に出すコードの形（5 文字ずつに区切る） */
export const formatClaimCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

/** 持ち主になるためのコードがまだ使えるか */
export async function claimOpen(db: SqlDb, shopId: string, now: number): Promise<boolean> {
  const raw = (await db.first<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [claimKey(shopId)]))?.value;
  try {
    const v = JSON.parse(raw ?? "null") as { exp?: number } | null;
    return !!v && typeof v.exp === "number" && v.exp >= now;
  } catch {
    return false;
  }
}

/** コードを確かめて持ち主にする。合えばコードを消す（1 回限り） */
export async function claimWithCode(db: SqlDb, shopId: string, userId: string, code: string, now: number): Promise<boolean> {
  const raw = (await db.first<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [claimKey(shopId)]))?.value;
  let v: { hash?: string; exp?: number } | null = null;
  try {
    v = JSON.parse(raw ?? "null") as { hash?: string; exp?: number } | null;
  } catch {
    v = null;
  }
  if (!v || typeof v.hash !== "string" || typeof v.exp !== "number" || v.exp < now) return false;
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!safeEqual(await sha256Hex(`${shopId}:${normalized}`), v.hash)) return false;
  if (!(await claimOwner(db, shopId, userId, now))) return false;
  // 使ったコードだけを消す（そのあいだにつなぎ直しで出た新しいコードは消さない）
  await db.run(`DELETE FROM kv WHERE key = ? AND value = ?`, [claimKey(shopId), raw!]);
  return true;
}

/** 画面に出す短い ID（Banto の運営者の ID の頭。名前は手代に届かない） */
export const shortUser = (id: string) => id.slice(0, 8);
