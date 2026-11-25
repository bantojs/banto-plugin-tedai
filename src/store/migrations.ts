/**
 * 手代の表（前方専用。前の版の SQL は書き換えず、新しい版を足す）。
 * Deploy ボタンで置いたあと運営者がコマンドを打たずに済むよう、Worker が起動して最初の要求で当てる。
 * 1 つの版は 1 つの batch で当てる（途中で失敗すれば丸ごと取り消される）。2 つの isolate が同時に当てて
 * 片方が失敗したら（作り直し・列を足す文は 2 度目に失敗する）、もう片方が当てたかを読み直して、当たっていれば続ける。
 *
 * 個人情報（メール・氏名・住所・LINE の ID）を置く列は作らない。置くのは Banto の ID・数・時刻だけ。
 */
import type { SqlDb } from "./sql";

export interface Migration {
  id: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    statements: [
      // つないだショップ（1 ショップ 1 行。つなぎ直したら上書き）。トークンと署名シークレットは TEDAI_SECRET で暗号化した箱だけ
      `CREATE TABLE IF NOT EXISTS connections (
        shop_id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        shop_slug TEXT NOT NULL,
        shop_name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        token_box TEXT NOT NULL,
        secret_box TEXT NOT NULL,
        banto_version TEXT,
        connected_by TEXT,
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS connections_endpoint ON connections(endpoint_id)`,
      // 受け取った配信（再送で二重に処理しないため。7 日で消す）
      `CREATE TABLE IF NOT EXISTS hook_deliveries (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        event TEXT NOT NULL,
        received_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS hook_deliveries_received ON hook_deliveries(received_at)`,
    ],
  },
  {
    id: "0002_purchases",
    statements: [
      // 会員の注文（ゲストの注文は置かない）。金額は値引き後の合計。updated_at は Banto の注文の更新時刻（取りこぼしの読み直しで、変わっていない注文を書き直さない）
      `CREATE TABLE IF NOT EXISTS orders (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        total_jpy INTEGER NOT NULL,
        ordered_at INTEGER NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0,
        banto_updated_at TEXT,
        PRIMARY KEY (shop_id, order_id)
      )`,
      `CREATE INDEX IF NOT EXISTS orders_customer ON orders(shop_id, customer_id, ordered_at)`,
      // 注文 × 商品（SKU ではなく商品で数える。同じ商品の SKU は足し合わせる）
      `CREATE TABLE IF NOT EXISTS order_products (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        qty INTEGER NOT NULL,
        amount_jpy INTEGER NOT NULL,
        PRIMARY KEY (shop_id, order_id, product_id)
      )`,
      `CREATE INDEX IF NOT EXISTS order_products_product ON order_products(shop_id, product_id)`,
      // 取りこぼしの読み直し（Banto の GET /orders?updated_since=&after= の続きの位置）
      `CREATE TABLE IF NOT EXISTS order_sync (
        shop_id TEXT PRIMARY KEY,
        updated_since TEXT NOT NULL,
        after TEXT,
        caught_up INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        last_error TEXT
      )`,
    ],
  },
  {
    id: "0003_favorites",
    statements: [
      // 会員のお気に入り（Banto の同梱モジュール favorites、0123）。再入荷・値下げ・残りわずかのきっかけに使う
      `CREATE TABLE IF NOT EXISTS favorites (
        shop_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, customer_id, product_id)
      )`,
      `CREATE INDEX IF NOT EXISTS favorites_product ON favorites(shop_id, product_id)`,
      // Banto の GET /favorites（足した順）の続きの位置
      `CREATE TABLE IF NOT EXISTS favorite_sync (
        shop_id TEXT PRIMARY KEY,
        since TEXT,
        after TEXT,
        caught_up INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        last_error TEXT
      )`,
    ],
  },
  {
    id: "0004_rules",
    statements: [
      // 商品の集まり（ルールの条件に使う）。商品の名前と URL の名前は画面に出すための写し（個人情報ではない）
      `CREATE TABLE IF NOT EXISTS product_sets (
        shop_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS product_set_items (
        shop_id TEXT NOT NULL,
        set_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        product_slug TEXT NOT NULL,
        PRIMARY KEY (shop_id, set_id, product_id)
      )`,
      // ルール: きっかけ → 条件（決まった部品の JSON）。アクションと待ちは後の版で足す
      `CREATE TABLE IF NOT EXISTS rules (
        shop_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        condition TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, id)
      )`,
      // ルールに当たった会員（同じ人に同じルールは 1 回: hit_key は会員 ID）
      `CREATE TABLE IF NOT EXISTS rule_hits (
        shop_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        hit_key TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        order_id TEXT,
        hit_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, rule_id, hit_key)
      )`,
      `CREATE INDEX IF NOT EXISTS rule_hits_recent ON rule_hits(shop_id, rule_id, hit_at)`,
      `CREATE INDEX IF NOT EXISTS rule_hits_customer ON rule_hits(shop_id, customer_id)`,
    ],
  },
  {
    id: "0005_actions",
    statements: [
      `ALTER TABLE rules ADD COLUMN actions TEXT NOT NULL DEFAULT '{}'`,
      // 手代の Worker 全体の小さな値（自分の公開の URL など）
      `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      // ショップごとの設定（送り手の名前・特定電子メール法の表示・運営者への知らせの宛先）。お客様の個人情報は置かない
      `CREATE TABLE IF NOT EXISTS shop_settings (shop_id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      // アクションの列（ルール × 会員で 1 行。id はルールと会員から作るので重ならない）。steps は済んだ手順と結果（会員 ID・状態だけ）
      `CREATE TABLE IF NOT EXISTS runs (
        shop_id TEXT NOT NULL,
        id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        order_id TEXT,
        status TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        steps TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS runs_due ON runs(status, due_at)`,
      `CREATE INDEX IF NOT EXISTS runs_rule ON runs(shop_id, rule_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS runs_customer ON runs(shop_id, customer_id)`,
    ],
  },
  {
    id: "0006_limits",
    statements: [
      // お客様に連絡した時刻（LINE かメールを送った列だけ）。お客様ごとの上限を数える
      `ALTER TABLE runs ADD COLUMN message_sent_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS runs_sent ON runs(shop_id, customer_id, message_sent_at)`,
    ],
  },
  {
    id: "0007_triggers",
    statements: [
      // きっかけの種類（order.paid / last_order / first_order / favorite_*）の日数と、種類ごとの選択
      `ALTER TABLE rules ADD COLUMN trigger_days INTEGER`,
      `ALTER TABLE rules ADD COLUMN trigger_opts TEXT NOT NULL DEFAULT '{}'`,
      // お気に入りのきっかけは、会員 × 商品で 1 回（hit_key に商品を入れ、ここにも持つ）
      `ALTER TABLE rule_hits ADD COLUMN product_id TEXT`,
      `ALTER TABLE runs ADD COLUMN product_id TEXT`,
      // 時刻のきっかけを、どこまで見たか（ルールごと）
      `CREATE TABLE IF NOT EXISTS rule_scans (
        shop_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        scanned_until INTEGER NOT NULL,
        PRIMARY KEY (shop_id, rule_id)
      )`,
      // お気に入りに入っている商品の、前に見た在庫と最安値（再入荷・値下げを見分ける）
      `CREATE TABLE IF NOT EXISTS product_state (
        shop_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        available INTEGER NOT NULL,
        min_price INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, product_id)
      )`,
    ],
  },
  {
    id: "0008_variants",
    statements: [
      // SKU ごとの在庫・値段・オプション（{ sku_id: [options, available, price] }）。オプションの組み合わせで再入荷・値下げを見る
      `ALTER TABLE product_state ADD COLUMN skus TEXT`,
      // 当たったオプションのまとまり（{ color: "red" } など。商品ごとなら null）
      `ALTER TABLE rule_hits ADD COLUMN variant TEXT`,
      `ALTER TABLE runs ADD COLUMN variant TEXT`,
    ],
  },
  {
    id: "0009_ref_at",
    statements: [
      // きっかけの時刻（カゴ落ちならレジを始めた時刻）。行う直前に「そのあと買ったか」を確かめる
      `ALTER TABLE runs ADD COLUMN ref_at INTEGER`,
    ],
  },
  {
    // 0009 は別の作業（カゴ落ちのきっかけ）が使う
    id: "0010_notices",
    statements: [
      // 取引の知らせの文面（ショップ × 種類）。無い種類は既定の文面で、送らない
      `CREATE TABLE IF NOT EXISTS notice_templates (
        shop_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL DEFAULT 'text',
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, kind)
      )`,
      // 送る列と記録（注文 × 種類で 1 行 = 二度送らない）。宛先・お名前は置かない（送る直前に Banto から読む）
      `CREATE TABLE IF NOT EXISTS notice_sends (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER NOT NULL,
        last_error TEXT,
        order_number INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, order_id, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS notice_sends_due ON notice_sends(status, due_at)`,
      `CREATE INDEX IF NOT EXISTS notice_sends_recent ON notice_sends(shop_id, created_at)`,
    ],
  },
  {
    id: "0011_admin_users",
    statements: [
      // 手代の画面を使える人（Banto の運営者の ID だけ。名前・メールは置かない）。owner = つないだ後に最初に開いた人、
      // member = owner が許した人、pending = 開こうとしたが許されていない人（owner の画面に並べる）。つなぎ直すと消す
      `CREATE TABLE IF NOT EXISTS admin_users (
        shop_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, user_id)
      )`,
      // 退会した会員の ID（ID だけ）。Banto は退会した会員の注文を残すので、読み直しやお気に入りの取り込みで記録を戻さないために覚える
      `CREATE TABLE IF NOT EXISTS forgotten_customers (
        shop_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, customer_id)
      )`,
    ],
  },
  {
    id: "0012_sending_marks",
    statements: [
      // 送っている途中の印（SMTP の知らせ。残ったまま取り直したら、送れたかもしれないとして送り直さない）
      `ALTER TABLE notice_sends ADD COLUMN sending_at INTEGER`,
      // 受け取った配信の重なりはショップごとに見る（別のショップの配信と ID が重なっても捨てない・消さない）
      `CREATE TABLE hook_deliveries_new (
        shop_id TEXT NOT NULL,
        id TEXT NOT NULL,
        event TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, id)
      )`,
      `INSERT OR IGNORE INTO hook_deliveries_new (shop_id, id, event, received_at) SELECT shop_id, id, event, received_at FROM hook_deliveries`,
      `DROP TABLE hook_deliveries`,
      `ALTER TABLE hook_deliveries_new RENAME TO hook_deliveries`,
      `CREATE INDEX IF NOT EXISTS hook_deliveries_received ON hook_deliveries(received_at)`,
    ],
  },
];

let applied: Promise<void> | null = null;

/** isolate ごとに 1 回だけ当てる（失敗したら次の要求でやり直す） */
export function ensureMigrated(db: SqlDb): Promise<void> {
  if (!applied) {
    applied = migrate(db).then(
      () => undefined,
      (e: unknown) => {
        applied = null;
        throw e;
      },
    );
  }
  return applied;
}

export async function migrate(db: SqlDb): Promise<string[]> {
  await db.run(`CREATE TABLE IF NOT EXISTS tedai_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const done = new Set((await db.all<{ id: string }>(`SELECT id FROM tedai_migrations`)).map((r) => r.id));
  const now = Math.floor(Date.now() / 1000);
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    try {
      await db.batch([...m.statements.map((sql) => ({ sql })), { sql: `INSERT OR IGNORE INTO tedai_migrations (id, applied_at) VALUES (?, ?)`, params: [m.id, now] }]);
    } catch (e) {
      if (await db.first(`SELECT id FROM tedai_migrations WHERE id = ?`, [m.id])) continue;
      throw e;
    }
    ran.push(m.id);
  }
  return ran;
}

/** テスト用: isolate の「当てた」覚えを消す */
export function resetMigratedForTest(): void {
  applied = null;
}
