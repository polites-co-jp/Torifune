-- アクセス・分析データ（02_データベース設計.md §5.8、06_画面設計.md §15）
--
-- 設計: docs/設計/018-analytics/設計.md
--
-- 2テーブルに分ける。
--   access_logs … Torifune 自身が計測タグで受ける「生のアクセス」
--   analytics   … 日次の集計値。Core の集計と、Plugin が外部サービスから
--                 取り込んだ値の両方が入る（source で区別する）

-- 計測タグがサイトを識別するための公開キー。
-- **漏れても被害は「偽のアクセスを送られる」に留める。**
-- このキーで読み出せるものを作らない（書き込み専用）。
ALTER TABLE sites ADD COLUMN public_key text;

-- 既存のサイトにも割り当てる。
--
-- **pgcrypto を要求しない。** `gen_random_bytes` は拡張が要り、
-- 拡張を入れられない環境（管理された PostgreSQL など）を排除してしまう。
-- `gen_random_uuid()` は PostgreSQL 13 以降の組み込みで、暗号論的に安全な乱数を使う。
-- 2つ繋げて 64桁の16進にする。
UPDATE sites
SET public_key = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE public_key IS NULL;

-- 新しいサイトにも自動で割り当てる。
-- **既定値を DB 側に持たせる。** アプリ側で入れる形にすると、
-- サイトを作る経路が増えたときに割り当て漏れが起きる。
ALTER TABLE sites ALTER COLUMN public_key SET DEFAULT
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

ALTER TABLE sites ALTER COLUMN public_key SET NOT NULL;
ALTER TABLE sites ADD CONSTRAINT sites_public_key_unique UNIQUE (public_key);

CREATE TABLE access_logs (
    id          uuid        PRIMARY KEY,
    site_id     uuid        NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    -- クエリ文字列は保存しない。トークンや個人情報が URL に入ることがある。
    path        text        NOT NULL,
    -- リファラは**ホストだけ**。パスまで持つと、他サイト上の閲覧内容が残る。
    referrer_host text,
    -- **IPアドレスと User-Agent の生値は保存しない。**
    -- sha256(日付ソルト + サイトID + IP + UA) を短縮したもの。
    -- ソルトが日ごとに変わるため、日をまたいで同じ人を追跡できない。
    visitor_hash text        NOT NULL,
    -- desktop / mobile / tablet / bot。bot は記録するが集計に含めない
    -- （捨てると「急に増えた」ときに Bot か確かめられない）。
    device      text        NOT NULL DEFAULT 'desktop',

    CONSTRAINT access_logs_device_check CHECK (device IN ('desktop', 'mobile', 'tablet', 'bot')),
    CONSTRAINT access_logs_path_not_blank CHECK (btrim(path) <> '')
);

-- 集計は「サイト × 期間」で引く。
CREATE INDEX access_logs_site_time_idx ON access_logs (site_id, occurred_at DESC);
-- 上位ページを出す。
CREATE INDEX access_logs_path_idx ON access_logs (site_id, path);
-- 古いログを消す（prune）。
CREATE INDEX access_logs_occurred_at_idx ON access_logs (occurred_at);

-- 日次の集計値。
--
-- **指標名を列にしない。** 列にすると、Plugin が別の指標を持てない。
CREATE TABLE analytics (
    site_id     uuid        NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    metric_date date        NOT NULL,
    -- 'core'（Torifune 自身の集計）か Plugin ID。
    source      text        NOT NULL DEFAULT 'core',
    -- 'pageviews' / 'visitors' / 'sessions' など。
    metric      text        NOT NULL,
    value       bigint      NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    -- ロールアップを再実行しても二重にならない。
    PRIMARY KEY (site_id, metric_date, source, metric),

    CONSTRAINT analytics_source_not_blank CHECK (btrim(source) <> ''),
    CONSTRAINT analytics_metric_not_blank CHECK (btrim(metric) <> ''),
    CONSTRAINT analytics_value_not_negative CHECK (value >= 0)
);

-- 期間で引く。
CREATE INDEX analytics_date_idx ON analytics (metric_date DESC);

INSERT INTO permissions (name, display_name, description, is_system) VALUES
    ('analytics.read', 'アナリティクスの参照', 'アクセス・分析データを表示できる', true);

INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000001', 'analytics.read'),
    ('01900000-0000-7000-8000-000000000002', 'analytics.read'),
    ('01900000-0000-7000-8000-000000000003', 'analytics.read');
