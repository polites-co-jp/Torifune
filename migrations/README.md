# migrations

DB マイグレーション（連番SQL）。

- ファイル名は `NNN_snake_case.sql`（例: `001_initial.sql`）
- 順番に適用できる状態を保つ
- 適用状況は対象DBの `schema_migrations` テーブルで管理する
- 適用は `torifune migrate --database-url=<url>`

実装は `001-database-foundation` で行う。
