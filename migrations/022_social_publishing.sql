-- SNS 投稿の自動配信と手動投稿（035-social-publishing 設計 §5）。
--
-- 既存行はすべて delivery_mode = 'auto'・media = []・provider_options = {}・attempt_count = 0 になり、
-- 他は NULL。**既存行の意味は変わらない**（scheduled_at が無い予約投稿は、これまでどおり誰も取り出さない）。
--
-- **新しいテーブル・Permission は作らない。** 取り出しには既存の
-- social_posts_status_scheduled_idx (status, scheduled_at)（005_social.sql）を使う。
--
-- **戻すとき**（手で戻す場合）: ALTER TABLE social_posts DROP COLUMN ... を 11 列ぶん。索引は列と一緒に落ちる。
ALTER TABLE social_posts
    ADD COLUMN delivery_mode       text        NOT NULL DEFAULT 'auto',
    ADD COLUMN media               jsonb       NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN link                text,
    ADD COLUMN provider_options    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN external_ref        text,
    -- Token を消しても投稿は残す（Token は「所有者を消したとき」にしか消えない。失効は revoked_at で行は残る）。
    ADD COLUMN created_by_token_id uuid        REFERENCES api_tokens (id) ON DELETE SET NULL,
    ADD COLUMN external_id         text,
    ADD COLUMN external_url        text,
    -- 配信の着手印。**publish() を呼ぶ前に書いてコミットする。** 非 NULL のまま残っている行は前回の実行が途中で死んだ行。
    ADD COLUMN publish_started_at  timestamptz,
    ADD COLUMN attempt_count       integer     NOT NULL DEFAULT 0,
    ADD COLUMN next_attempt_at     timestamptz,
    ADD CONSTRAINT social_posts_delivery_mode_check CHECK (delivery_mode IN ('auto', 'manual')),
    ADD CONSTRAINT social_posts_media_is_array CHECK (jsonb_typeof(media) = 'array'),
    ADD CONSTRAINT social_posts_provider_options_is_object CHECK (jsonb_typeof(provider_options) = 'object'),
    ADD CONSTRAINT social_posts_link_length CHECK (link IS NULL OR char_length(link) <= 2048),
    ADD CONSTRAINT social_posts_external_ref_format
        CHECK (external_ref IS NULL OR (btrim(external_ref) <> '' AND char_length(external_ref) <= 200)),
    ADD CONSTRAINT social_posts_external_id_length CHECK (external_id IS NULL OR char_length(external_id) <= 200),
    ADD CONSTRAINT social_posts_external_url_length CHECK (external_url IS NULL OR char_length(external_url) <= 2048),
    ADD CONSTRAINT social_posts_attempt_count_check CHECK (attempt_count >= 0);

-- 冪等な登録（設計 §6.1.3）。同じ外部アプリ（Token）からの同じ external_ref は 1 行。
-- Token 無し（セッションからの登録）は external_ref を持てないので索引から外す。
CREATE UNIQUE INDEX social_posts_token_external_ref_key
    ON social_posts (created_by_token_id, external_ref)
    WHERE created_by_token_id IS NOT NULL AND external_ref IS NOT NULL;

-- 外部キーの参照側の索引（019_foreign_key_indexes.sql と同じ理由。ON DELETE SET NULL が全走査にならないように）。
CREATE INDEX social_posts_created_by_token_idx
    ON social_posts (created_by_token_id)
    WHERE created_by_token_id IS NOT NULL;
