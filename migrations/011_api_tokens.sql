-- 外部クライアント向けの API Token（05_API設計.md §37-38）。
--
-- 設計は docs/設計/021-api-token/設計.md。

CREATE TABLE api_tokens (
    id           uuid        PRIMARY KEY,
    -- 所有者。他人のための Token は作れない（権限の貸し出しになるため）。
    -- ユーザーを消したら Token も消す。残しても使えないうえ、危険なだけ。
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- 人が見分けるための名前。
    name         text        NOT NULL,
    -- 平文は保存しない。SHA-256 のみ（sessions と同じ扱い）。
    token_hash   text        NOT NULL UNIQUE,
    -- 一覧でどの Token かを見分けるための先頭数文字。
    -- これだけでは認証に使えない。
    prefix       text        NOT NULL,
    -- Permission の部分集合。使用時は「所有者のいまの Permission ∩ これ」。
    -- Token は権限を増やせない。絞るだけ。
    scopes       text[]      NOT NULL DEFAULT '{}',
    -- NULL は無期限。既定では期限を付ける想定。
    expires_at   timestamptz,
    last_used_at timestamptz,
    -- 失効しても行は消さない。消すと監査が追えない。
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT api_tokens_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT api_tokens_prefix_not_blank CHECK (btrim(prefix) <> '')
);

-- 認証のたびに引く。一意索引が既にあるので token_hash は不要。
-- 「自分の Token 一覧」を新しい順に出す。
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at DESC);

-- Token を発行・失効できる権限。アカウントの分身を作る操作なので、
-- 既定では administrator にだけ与える。
INSERT INTO permissions (name, display_name, description, is_system) VALUES
    ('token.manage', 'APIトークン管理', 'APIトークンを発行・失効できる', true);

INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000001', 'token.manage');
