/**
 * 保存の層の一番下: SQL を流すだけの継ぎ目。
 * Workers では D1（src/adapters/workers/d1.ts）、テストと Node では SQLite が実装する。
 * SQL は SQLite の方言で書く（D1 は SQLite）。上の層（repo）は D1 を直接知らない。
 */
export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlDb {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** まとめて 1 つの取引で流す（途中で失敗したら全部戻る） */
  batch(statements: SqlStatement[]): Promise<{ changes: number }[]>;
}
