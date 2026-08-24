-- SNSアカウントと投稿
--
-- **外部SNSとの実連携は Plugin の責務**（01_アーキテクチャ設計.md §12）。
-- ここが持つのはデータの箱と状態管理まで。
--
-- 設計: docs/設計/009-social/設計.md §5

CREATE TABLE social_accounts (
    id           uuid        PRIMARY KEY,
    -- provider を CHECK 制約で固定しない。Plugin が新しいSNSを足せる必要がある。
    -- 形式だけを制限する（任意の文字列だと画面や URL で扱いにくい）。
    provider     text        NOT NULL,
    display_name text        NOT NULL,
    handle       text        NOT NULL DEFAULT '',
    -- 暗号化した資格情報（006-secret-storage の形式）。**平文を入れてはならない。**
    credential   text,
    status       text        NOT NULL DEFAULT 'disconnected',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT social_accounts_provider_format CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
    CONSTRAINT social_accounts_display_name_not_blank CHECK (btrim(display_name) <> ''),
    CONSTRAINT social_accounts_status_check
        CHECK (status IN ('connected', 'disconnected', 'error')),
    -- 暗号化済みの形式であることを、DB 側でも確かめる。
    -- 平文をうっかり入れる経路を1つ塞ぐ。
    CONSTRAINT social_accounts_credential_encrypted
        CHECK (credential IS NULL OR credential ~ '^v[0-9]+\.')
);

CREATE INDEX social_accounts_provider_idx ON social_accounts (provider);
CREATE INDEX social_accounts_created_at_idx ON social_accounts (created_at DESC);

CREATE TABLE social_posts (
    id                uuid        PRIMARY KEY,
    -- アカウントを削除したら投稿も消す。切り離された投稿は、
    -- どこへ出すものか分からず意味を持たない。
    social_account_id uuid        NOT NULL REFERENCES social_accounts (id) ON DELETE CASCADE,
    body              text        NOT NULL,
    scheduled_at      timestamptz,
    status            text        NOT NULL DEFAULT 'draft',
    published_at      timestamptz,
    failure_reason    text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT social_posts_body_not_blank CHECK (btrim(body) <> ''),
    CONSTRAINT social_posts_body_length CHECK (char_length(body) <= 10000),
    CONSTRAINT social_posts_status_check
        CHECK (status IN ('draft', 'scheduled', 'published', 'failed'))
);

CREATE INDEX social_posts_account_created_idx
    ON social_posts (social_account_id, created_at DESC);
-- 予約投稿の取り出し（将来のワーカー用）。
CREATE INDEX social_posts_status_scheduled_idx ON social_posts (status, scheduled_at);
