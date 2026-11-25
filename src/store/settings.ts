/** ショップごとの設定と、Worker 全体の小さな値 */
import { DEFAULT_ACCENT, isColor } from "../mail/html";
import { isEmail, parseAddress } from "../mail/message";
import type { SqlDb } from "./sql";

export interface ShopSettings {
  /** 送り手（"店の名前 <news@shop.example>"）。送り手のサービスで確かめたドメインのアドレス */
  mail_from: string;
  reply_to: string;
  /** 特定電子メール法の表示: 送信者の名前・住所・問い合わせ先 */
  sender_name: string;
  sender_address: string;
  sender_contact: string;
  /** 運営者への知らせ（メール）の宛先 */
  operator_email: string;
  /** 飾りのあるメール（HTML）の見た目: ボタンと線の色（#rrggbb）・ロゴの画像（https://、空ならショップの名前を文字で） */
  mail_accent: string;
  mail_logo_url: string;
  /** お客様ごとの連絡（LINE・メール）の上限。全ルールを合わせて 1 日・7 日あたり。0 は上限なし */
  cap_day: number;
  cap_week: number;
  /** 夜は送らない（日本時間の時。start 時から end 時まで。同じなら止めない） */
  quiet_start: number;
  quiet_end: number;
}

export const EMPTY_SETTINGS: ShopSettings = {
  mail_from: "",
  reply_to: "",
  sender_name: "",
  sender_address: "",
  sender_contact: "",
  operator_email: "",
  mail_accent: DEFAULT_ACCENT,
  mail_logo_url: "",
  cap_day: 1,
  cap_week: 3,
  quiet_start: 21,
  quiet_end: 9,
};

const TEXT_KEYS = ["mail_from", "reply_to", "sender_name", "sender_address", "sender_contact", "operator_email", "mail_accent", "mail_logo_url"] as const;
const NUM_KEYS = { cap_day: [0, 10], cap_week: [0, 50], quiet_start: [0, 23], quiet_end: [0, 23] } as const;

export async function getSettings(db: SqlDb, shopId: string): Promise<ShopSettings> {
  const r = await db.first<{ value: string }>(`SELECT value FROM shop_settings WHERE shop_id = ?`, [shopId]);
  if (!r) return { ...EMPTY_SETTINGS };
  try {
    const v = JSON.parse(r.value) as Record<string, unknown>;
    const out = { ...EMPTY_SETTINGS };
    for (const k of TEXT_KEYS) if (typeof v[k] === "string") out[k] = v[k];
    for (const [k, [lo, hi]] of Object.entries(NUM_KEYS) as [keyof typeof NUM_KEYS, readonly [number, number]][]) {
      const n = v[k];
      if (typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi) out[k] = n;
    }
    return out;
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

export async function saveSettings(db: SqlDb, shopId: string, s: ShopSettings, now: number): Promise<void> {
  await db.run(`INSERT INTO shop_settings (shop_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(shop_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [
    shopId,
    JSON.stringify(s),
    now,
  ]);
}

/** 画面の値を確かめる。誤りは画面に出す文 */
export function parseSettingsForm(f: Record<string, string | undefined>): { settings: ShopSettings; errors: string[] } {
  const t = (k: (typeof TEXT_KEYS)[number], max: number) => (f[k] ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  const errors: string[] = [];
  const num = (k: keyof typeof NUM_KEYS, label: string): number => {
    const [lo, hi] = NUM_KEYS[k];
    const raw = (f[k] ?? "").trim();
    const n = raw === "" ? EMPTY_SETTINGS[k] : Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      errors.push(`${label}は ${lo}〜${hi} にしてください`);
      return EMPTY_SETTINGS[k];
    }
    return n;
  };
  const s: ShopSettings = {
    mail_from: t("mail_from", 200),
    reply_to: t("reply_to", 200),
    sender_name: t("sender_name", 100),
    sender_address: t("sender_address", 200),
    sender_contact: t("sender_contact", 200),
    operator_email: t("operator_email", 200),
    mail_accent: t("mail_accent", 20).toLowerCase() || DEFAULT_ACCENT,
    mail_logo_url: t("mail_logo_url", 1000),
    cap_day: num("cap_day", "1 日の上限"),
    cap_week: num("cap_week", "7 日の上限"),
    quiet_start: num("quiet_start", "送らない時間の始まり"),
    quiet_end: num("quiet_end", "送らない時間の終わり"),
  };
  const addr = (v: string, label: string) => {
    if (!v) return;
    try {
      parseAddress(v);
    } catch {
      errors.push(`${label}の形が違います`);
    }
  };
  addr(s.mail_from, "送り手のアドレス");
  addr(s.reply_to, "返信先");
  if (s.operator_email && !isEmail(s.operator_email)) errors.push("運営者への知らせの宛先の形が違います");
  if (!isColor(s.mail_accent)) errors.push("メールの色は #rrggbb の形にしてください");
  if (s.mail_logo_url && !httpsUrl(s.mail_logo_url)) errors.push("ロゴの画像は https:// の URL にしてください");
  return { settings: s, errors };
}

const httpsUrl = (v: string) => {
  if (/[\s"'<>\\]/.test(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** 案内メールを送れる設定がそろっているか（特定電子メール法の表示を含む） */
export const mailReady = (s: ShopSettings) => !!(s.mail_from && s.sender_name && s.sender_address && s.sender_contact);

export async function getKv(db: SqlDb, key: string): Promise<string | null> {
  return (await db.first<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [key]))?.value ?? null;
}

export async function setKv(db: SqlDb, key: string, value: string): Promise<void> {
  await db.run(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE kv.value <> excluded.value`, [key, value]);
}

/**
 * 回数の上限（key ごとに interval 秒に 1 回）。読んでから書くのではなく 1 つの書き込みで取るので、同時に押されても 1 回だけ通る。
 * 通ってよければ true
 */
export async function takeSlot(db: SqlDb, key: string, now: number, interval: number): Promise<boolean> {
  const r = await db.run(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(kv.value AS INTEGER) <= ?`,
    [key, String(now), now - interval],
  );
  return r.changes > 0;
}

/** 手代の公開の URL（配信停止のリンクに使う。Cron には要求の URL が無いので、画面を開いたときに覚える） */
export const SELF_ORIGIN = "self_origin";

const JST = 9 * 3600;

/** 日本時間の時（0〜23） */
export const jstHour = (now: number) => Math.floor((((now + JST) % 86400) + 86400) % 86400 / 3600);

/** 送らない時間か。送らない時間なら、送ってよくなる時刻（日本時間の end 時ちょうど）を返す */
export function quietUntil(s: Pick<ShopSettings, "quiet_start" | "quiet_end">, now: number): number | null {
  const { quiet_start: a, quiet_end: b } = s;
  if (a === b) return null;
  const h = jstHour(now);
  const inQuiet = a < b ? h >= a && h < b : h >= a || h < b;
  if (!inQuiet) return null;
  const dayStart = now - (((now + JST) % 86400) + 86400) % 86400; // 日本時間のその日の 0 時（UTC 秒）
  let until = dayStart + b * 3600;
  if (until <= now) until += 86400;
  return until;
}
