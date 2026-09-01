-- システム設定（06_画面設計.md §16 の「一般」「認証」タブ）。
--
-- 1行1カラムの固定テーブルにすると、設定が増えるたびにマイグレーションが要る。
-- 設定は増える。Plugin の設定（plugin_store）と同じ key-value の形にそろえる。
-- 読み出しは型付きのアクセサ経由にして、呼び出し側が生の JSON を触らない。

CREATE TABLE system_settings (
    key        text        PRIMARY KEY,
    value      jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT system_settings_key_format CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$')
);

-- 認証方式の変更と Permission の変更を記録できるようにする（04_認証設計.md §26）。
-- 対応する操作は Plugin の有効化・無効化で起きる（設計 §3.4、§3.5）。
-- ここでは列挙を持たないため、DDL の変更は要らない。
