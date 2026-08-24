-- Plugin ごとの Key-Value Store
--
-- Plugin が必要とするデータの形は Core には決められない。
-- 設定と少量のデータのために毎回マイグレーションを書かせるのは重いので、
-- ここを既定の置き場にする（03_プラグイン設計.md §18-19）。
--
-- **Plugin は自分の plugin_id の範囲しか触れない。**
-- plugin_id は PluginContext が閉じ込め、Plugin から指定させない。
-- 指定できると、他の Plugin の資格情報を読めてしまう。
--
-- 設計: docs/設計/010-plugin-api/設計.md §5

CREATE TABLE plugin_store (
    plugin_id  text        NOT NULL,
    key        text        NOT NULL,
    value      jsonb       NOT NULL,
    -- 真なら value は暗号化した文字列を含む。get() では取り出せない。
    is_secret  boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (plugin_id, key),

    CONSTRAINT plugin_store_plugin_id_format CHECK (plugin_id ~ '^[a-z][a-z0-9-]{1,63}$'),
    CONSTRAINT plugin_store_key_format CHECK (key ~ '^[a-z0-9][a-z0-9._/-]{0,127}$')
);

-- 接頭辞での絞り込み。
CREATE INDEX plugin_store_plugin_key_idx ON plugin_store (plugin_id, key text_pattern_ops);
