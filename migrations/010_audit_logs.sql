-- 一般API操作の監査ログ（05_API設計.md §42）。
--
-- 認証・認可のセキュリティログ（auth_audit_logs、04_認証設計.md §26）とは分ける。
-- 読み手が違う（前者は侵害調査、後者は操作の追跡）ため、
-- イベント名の集合を共有すると片方の都合でもう片方が歪む。
-- 詳しくは docs/設計/022-hardening/設計.md §3.1。

CREATE TABLE audit_logs (
    id            uuid        PRIMARY KEY,
    -- 操作した人。ユーザーを削除しても監査記録は消さない。
    actor_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
    -- 何をしたか。'created' / 'updated' / 'deleted' / 'enabled' など。
    action        text        NOT NULL,
    -- 何に対してか。'site' / 'social_account' / 'plugin' など。
    resource_type text        NOT NULL,
    -- 対象の識別子。Plugin ID のように uuid でないものもあるため text。
    resource_id   text,
    -- パスワード・トークン・Cookie をここへ入れてはならない。
    -- sanitizeAuditDetail が機械的に落とす。
    detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ip_address    inet,
    user_agent    text,
    occurred_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT audit_logs_action_not_blank CHECK (btrim(action) <> ''),
    CONSTRAINT audit_logs_resource_type_not_blank CHECK (btrim(resource_type) <> '')
);

-- 時系列で読むのが基本。
CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at DESC);

-- 「このリソースに何が起きたか」を引く。
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, occurred_at DESC);

-- 「この人が何をしたか」を引く。
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);
