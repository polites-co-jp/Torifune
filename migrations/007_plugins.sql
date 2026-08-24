-- 導入済み Plugin の状態
--
-- **plugins に行が無い Plugin は「未導入」。**
-- plugins/ にファイルがあっても、DB に行が無ければ動かない。
-- ファイルを置いただけで勝手に動くと、意図しないコードが実行される。
--
-- 設計: docs/設計/011-plugin-runtime/設計.md §5

CREATE TABLE plugins (
    id           text        PRIMARY KEY,
    -- 導入時のバージョン。ファイル側が更新されたことを検出するために持つ。
    version      text        NOT NULL,
    status       text        NOT NULL DEFAULT 'installed',
    installed_at timestamptz NOT NULL DEFAULT now(),
    enabled_at   timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT plugins_id_format CHECK (id ~ '^[a-z][a-z0-9-]{1,63}$'),
    CONSTRAINT plugins_status_check CHECK (status IN ('installed', 'enabled', 'disabled'))
);

CREATE INDEX plugins_status_idx ON plugins (status);
