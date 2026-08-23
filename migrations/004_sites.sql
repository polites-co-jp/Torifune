-- Webサイト
--
-- 設計: docs/設計/007-sites/設計.md §5

CREATE TABLE sites (
    id          uuid        PRIMARY KEY,
    name        text        NOT NULL,
    url         text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    status      text        NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- 作成者を消してもサイトは残す。
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,

    CONSTRAINT sites_status_check CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT sites_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT sites_name_length CHECK (char_length(name) <= 200),
    CONSTRAINT sites_url_scheme CHECK (url ~ '^https?://')
);

-- URL に一意制約を付けない。同じサイトを別の目的で2つ登録したい場合がある
-- （本番と検証、言語別など）。重複は利用者の判断に任せる。

CREATE INDEX sites_created_at_idx ON sites (created_at DESC);
CREATE INDEX sites_status_idx ON sites (status);
CREATE INDEX sites_name_lower_idx ON sites (lower(name));
