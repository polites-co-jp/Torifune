-- 集計値の内訳キーと、最終受信の書き戻し（02_データベース設計.md §5.8, §12）
--
-- 設計: docs/設計/028-analytics-dashboard-redesign/設計.md §5.1
--
-- **適用後の運用手順（既存環境を更新するとき）**
--
-- このマイグレーションと同時に、日次集計（rollup）の中身が変わる。
--   * `sessions` が「訪問者 × 日」から「30 分区切りのセッション数」になる
--   * `bounces` / `dwell_ms` / パス別・参照元別・時間帯別などの指標が増える
-- 保存済みの集計値は勝手には直らない。**保持している生ログの期間でロールアップを流し直す。**
--
--   1. `pnpm migrate`（このファイルを適用する）
--   2. 生ログの最も古い日を確かめる:  SELECT min(occurred_at) FROM access_logs;
--   3. `POST /api/v1/analytics/rollup` に {"from":"<最古の日>","to":"<今日>"} を渡して流し直す
--      （400 日を超える場合は分割する）
--   4. 生ログを消してしまった期間の `sessions` は旧定義のまま残り、`bounces` 等は無い。
--      集計値は消さない（旧定義の値でも、無いよりは比較に使える）
--
-- 詳しくは docs/マニュアル/アクセス解析設置.md §4 を参照。
--
-- **戻すとき**（ランナーは前進のみ。手で戻す場合）:
-- `key <> ''` の行が存在すると 4 列の主キーには戻せない。先にそれらの行を消してから
-- `key` 列と索引を落とす。

-- 内訳キー。指標名の列は増やさない（isValidMetricName に収まらない値を key に逃がす）。
-- 空文字は「キーを持たない指標」（pageviews / visitors 等）。既存行はすべて空文字になる。
ALTER TABLE analytics ADD COLUMN key text NOT NULL DEFAULT '';

-- 500 は PATH_MAX_LENGTH と同じ。パスを key に入れるため。
ALTER TABLE analytics ADD CONSTRAINT analytics_key_length CHECK (char_length(key) <= 500);

-- 主キーに key を足す。4 列で一意だった行は 5 列でも一意なので失敗しない。
ALTER TABLE analytics DROP CONSTRAINT analytics_pkey;
ALTER TABLE analytics ADD PRIMARY KEY (site_id, metric_date, source, metric, key);

-- 「サイト × 指標 × 期間」で内訳を引く。
CREATE INDEX analytics_site_metric_idx ON analytics (site_id, metric, metric_date DESC);

-- 最終受信。collect のたびに UPDATE せず、rollup が max(occurred_at) を書き戻す。
ALTER TABLE sites ADD COLUMN analytics_last_seen_at timestamptz;

-- セッションを組む並び順。
CREATE INDEX access_logs_visitor_idx ON access_logs (site_id, visitor_hash, occurred_at);

-- 上位ページは analytics（path_pageviews）から引くようになり、生ログをパスで引く読み手が無くなる。
-- 使われない索引は collect の書き込みを重くするだけなので落とす。
DROP INDEX IF EXISTS access_logs_path_idx;
