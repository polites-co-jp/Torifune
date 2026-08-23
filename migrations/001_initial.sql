-- Torifune 初期スキーマ
--
-- 認証・認可に必要なテーブルだけを作る。
-- マーケティング系のテーブルは、各機能のスプリントで個別のマイグレーションとして足す。
--
-- 設計: docs/設計/001-database-foundation/設計.md §5

-- ---------------------------------------------------------------------------
-- ユーザー
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id            uuid        PRIMARY KEY,
    login_id      text        NOT NULL,
    email         text        NOT NULL,
    display_name  text        NOT NULL,
    -- 外部認証だけを使うユーザーはパスワードを持たない。
    -- ハッシュのみを保存し、平文は保存しない（04_認証設計.md §6）。
    password_hash text,
    status        text        NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,

    CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
    CONSTRAINT users_login_id_not_blank CHECK (btrim(login_id) <> ''),
    CONSTRAINT users_email_not_blank CHECK (btrim(email) <> ''),
    CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> '')
);

-- 大文字小文字を区別しない一意性。
-- citext 拡張に依存させないために式インデックスで表現する。
CREATE UNIQUE INDEX users_login_id_lower_key ON users (lower(login_id));
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- ---------------------------------------------------------------------------
-- ロールと権限
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
    id           uuid        PRIMARY KEY,
    name         text        NOT NULL UNIQUE,
    display_name text        NOT NULL,
    -- 標準で用意するロール。削除・改名を禁止する。
    is_system    boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT roles_name_format CHECK (name ~ '^[a-z][a-z0-9_]*$')
);

-- Permission は名前を自然キーにする。
-- Plugin が自分の Permission を登録できる必要があるため（03_プラグイン設計.md §20.2）、
-- 数値IDよりも文字列で参照できるほうが素直になる。
CREATE TABLE permissions (
    name         text        PRIMARY KEY,
    display_name text        NOT NULL,
    description  text        NOT NULL DEFAULT '',
    -- Torifune 本体が定義する Permission。Plugin が登録したものと区別する。
    is_system    boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT permissions_name_format CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,

    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);

CREATE TABLE role_permissions (
    role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission_name text NOT NULL REFERENCES permissions (name) ON DELETE CASCADE,

    PRIMARY KEY (role_id, permission_name)
);

CREATE INDEX role_permissions_permission_name_idx ON role_permissions (permission_name);

-- ---------------------------------------------------------------------------
-- セッション
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
    id               uuid        PRIMARY KEY,
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Cookie に入るトークンそのものは保存しない。ハッシュだけを保存する。
    -- DB が漏れてもセッションを乗っ取れないようにするため（04_認証設計.md §7）。
    token_hash       text        NOT NULL UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_accessed_at timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    revoked_at       timestamptz,
    ip_address       inet,
    user_agent       text
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- 認証監査ログ
-- ---------------------------------------------------------------------------

CREATE TABLE auth_audit_logs (
    id                 uuid        PRIMARY KEY,
    event              text        NOT NULL,
    -- ユーザーを削除しても監査記録は消さない。
    user_id            uuid        REFERENCES users (id) ON DELETE SET NULL,
    -- 存在しないアカウントへのログイン試行も記録するため、ユーザーとは別に持つ。
    login_id_attempted text,
    ip_address         inet,
    user_agent         text,
    -- パスワード・トークン・Cookie をここへ入れてはならない（04_認証設計.md §26）。
    detail             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_audit_logs_occurred_at_idx ON auth_audit_logs (occurred_at DESC);
CREATE INDEX auth_audit_logs_user_id_occurred_at_idx ON auth_audit_logs (user_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 初期データ
-- ---------------------------------------------------------------------------

INSERT INTO permissions (name, display_name, description, is_system) VALUES
    ('site.read',      'サイトの参照',       'Webサイトの一覧と詳細を表示できる',   true),
    ('site.write',     'サイトの編集',       'Webサイトを作成・更新できる',         true),
    ('site.delete',    'サイトの削除',       'Webサイトを削除できる',               true),
    ('content.read',   'コンテンツの参照',   'コンテンツの一覧と詳細を表示できる',   true),
    ('content.write',  'コンテンツの編集',   'コンテンツを作成・更新できる',         true),
    ('content.delete', 'コンテンツの削除',   'コンテンツを削除できる',               true),
    ('social.read',    'SNSの参照',          'SNSアカウントと投稿を表示できる',      true),
    ('social.write',   'SNSの編集',          'SNSアカウントと投稿を作成・更新できる', true),
    ('social.delete',  'SNSの削除',          'SNSアカウントと投稿を削除できる',      true),
    ('user.manage',    'ユーザー管理',       'ユーザーとロールを管理できる',         true),
    ('plugin.manage',  'プラグイン管理',     'プラグインの導入と有効・無効を操作できる', true),
    ('system.manage',  'システム管理',       'システム全体の設定を変更できる',       true);

INSERT INTO roles (id, name, display_name, is_system) VALUES
    ('01900000-0000-7000-8000-000000000001', 'administrator', '管理者',   true),
    ('01900000-0000-7000-8000-000000000002', 'editor',        '編集者',   true),
    ('01900000-0000-7000-8000-000000000003', 'viewer',        '閲覧者',   true);

-- administrator は全 Permission を持つ。
-- 後から Permission が増えたときは、その Permission を追加するマイグレーションで
-- administrator への割り当ても行う（ここで動的に拾うと、Plugin が登録した
-- Permission まで自動的に administrator へ付いてしまい、最小権限の原則に反する）。
INSERT INTO role_permissions (role_id, permission_name)
SELECT '01900000-0000-7000-8000-000000000001', name
FROM permissions
WHERE is_system = true;

INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000002', 'site.read'),
    ('01900000-0000-7000-8000-000000000002', 'site.write'),
    ('01900000-0000-7000-8000-000000000002', 'content.read'),
    ('01900000-0000-7000-8000-000000000002', 'content.write'),
    ('01900000-0000-7000-8000-000000000002', 'social.read'),
    ('01900000-0000-7000-8000-000000000002', 'social.write');

INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000003', 'site.read'),
    ('01900000-0000-7000-8000-000000000003', 'content.read'),
    ('01900000-0000-7000-8000-000000000003', 'social.read');
