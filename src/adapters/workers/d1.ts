/** 保存の層（src/store/sql.ts）の D1 の実装。Cloudflare の型を書いてよいのはここと src/index.ts だけ */
import type { SqlDb, SqlStatement, SqlValue } from "../../store/sql";

export function d1Sql(d1: D1Database): SqlDb {
  const prep = (sql: string, params: SqlValue[] = []) => d1.prepare(sql).bind(...params);
  return {
    async all<T>(sql: string, params?: SqlValue[]) {
      return (await prep(sql, params).all<T>()).results;
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async run(sql: string, params?: SqlValue[]) {
      return { changes: (await prep(sql, params).run()).meta.changes };
    },
    async batch(statements: SqlStatement[]) {
      const rs = await d1.batch(statements.map((s) => prep(s.sql, s.params)));
      return rs.map((r) => ({ changes: r.meta.changes }));
    },
  };
}
