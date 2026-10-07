-- SNS アカウントと API トークンを Web サイトに紐づける（053-site-scoped-social 設計 §7）。
--
-- 1. social_accounts.site_id：アカウントが属するサイト。NULL は共通（どのサイトのトークンからも使える）。
--    **サイトの削除を断る（RESTRICT）。** CASCADE だと SNS アカウントと投稿が黙って消え、
--    SET NULL だとサイト専用のアカウントが黙って共通に化ける（範囲が広がる）。
-- 2. api_tokens.site_id / site_scoped：サイトのトークン。発行時に決まり、画面の変更の操作でだけ変わる（設計 §8.5.6）。
--    **サイトを消すと site_id は NULL になるが site_scoped は残る**ので、全体用（共通）のトークンには化けない
--    （アプリは site_scoped で site_id が NULL のトークンを使えないものとして扱う。設計 §8.5.3）。
--    失効しても行は消さない（011）ので、RESTRICT にすると失効済みのトークンが永久にサイトの削除を止める。
--    サイトのトークンの Scope は SNS の 4 つに限る（設計 §7.2・裁定 6）。
-- 3. social_posts.origin_site_id / origin_site_scoped：登録した区画（共通のアカウントの投稿の区画に使う。設計 §5.2）。
--    トークンの行に頼らないのは、トークンの所有者を消すとトークンの行が消え（011 の CASCADE）、
--    created_by_token_id が NULL になって投稿が共通の区画へ化けるため。
--
-- 既存行はすべて site_id = NULL・site_scoped = false・origin_site_id = NULL・origin_site_scoped = false になり、
-- 意味は変わらない（設計 §5.3）。新しい Permission は作らない。
--
-- **戻すとき**（手で戻す場合）:
--   ALTER TABLE social_posts DROP CONSTRAINT social_posts_origin_site_check,
--     DROP COLUMN origin_site_scoped, DROP COLUMN origin_site_id;
--   ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_site_scopes_check, DROP CONSTRAINT api_tokens_site_scoped_check,
--     DROP COLUMN site_scoped, DROP COLUMN site_id;
--   ALTER TABLE social_accounts DROP COLUMN site_id;
--   （索引は列と一緒に落ちる。**サイトのトークンが残っていれば、先に失効させてから戻す**。戻すと全体用に化ける）
ALTER TABLE social_accounts
    ADD COLUMN site_id uuid REFERENCES sites (id) ON DELETE RESTRICT;

CREATE INDEX social_accounts_site_idx ON social_accounts (site_id) WHERE site_id IS NOT NULL;

ALTER TABLE api_tokens
    ADD COLUMN site_id     uuid    REFERENCES sites (id) ON DELETE SET NULL,
    ADD COLUMN site_scoped boolean NOT NULL DEFAULT false,
    -- サイトを持つトークンは必ずサイトのトークン。逆（site_scoped でサイトが NULL）はサイトが消えたあとの形。
    ADD CONSTRAINT api_tokens_site_scoped_check CHECK (site_id IS NULL OR site_scoped),
    -- サイトのトークンは SNS の権限しか持てない（設計 §7.2）。domain/api-token.ts の SITE_TOKEN_SCOPES と一致させる。
    ADD CONSTRAINT api_tokens_site_scopes_check CHECK (
        NOT site_scoped
        OR scopes <@ ARRAY['social.read', 'social.write', 'social.delete', 'social.approve']::text[]
    );

CREATE INDEX api_tokens_site_idx ON api_tokens (site_id) WHERE site_id IS NOT NULL;

ALTER TABLE social_posts
    ADD COLUMN origin_site_id     uuid    REFERENCES sites (id) ON DELETE SET NULL,
    ADD COLUMN origin_site_scoped boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT social_posts_origin_site_check CHECK (origin_site_id IS NULL OR origin_site_scoped);

CREATE INDEX social_posts_origin_site_idx ON social_posts (origin_site_id) WHERE origin_site_id IS NOT NULL;
