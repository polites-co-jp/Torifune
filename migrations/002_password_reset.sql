-- パスワードリセットとログイン試行制限
--
-- 設計: docs/設計/002-authentication/設計.md §5

CREATE TABLE password_reset_tokens (
    id         uuid        PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- トークンそのものは保存しない。ハッシュだけを保存する（04_認証設計.md §24）。
    token_hash text        NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    -- 一度使ったトークンを無効にする。
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
CREATE INDEX password_reset_tokens_expires_at_idx ON password_reset_tokens (expires_at);

-- ログインの失敗記録。時間窓の中の件数で判定する。
-- Redis 等の外部依存を増やさず DB で持つ。単体で動くことを優先する。
CREATE TABLE login_attempts (
    id          uuid        PRIMARY KEY,
    -- 'ip:1.2.3.4' / 'login:alice' の形式。
    key         text        NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_key_occurred_at_idx ON login_attempts (key, occurred_at DESC);
