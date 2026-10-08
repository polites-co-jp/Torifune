-- SNS 投稿を登録したトークンの名前の写し（054-bulk-post-actions 設計 §5.6・§7）。
--
-- 投稿一覧の「登録元」に出す。トークンの行は所有者のユーザーを削除すると消え、
-- created_by_token_id は ON DELETE SET NULL で NULL になる（022）。写しが無いと、その投稿は
-- 画面（セッション）で登録した投稿と見分けられなくなる。トークンの名前は発行後に変えられない（053 §8.5.6）。
--
-- 既存行：トークンの行が残っている投稿はその名前で埋める。既に NULL の投稿は NULL のまま（見分けようが無い）。
--
-- **戻すとき**:
--   ALTER TABLE social_posts DROP CONSTRAINT social_posts_created_by_token_name_check,
--     DROP COLUMN created_by_token_name;
ALTER TABLE social_posts
    ADD COLUMN created_by_token_name text;

UPDATE social_posts AS p
   SET created_by_token_name = t.name
  FROM api_tokens AS t
 WHERE p.created_by_token_id = t.id;

ALTER TABLE social_posts
    -- トークンで登録した投稿は必ず名前を持つ。空白だけの名前は api_tokens でも断っている（011）。
    ADD CONSTRAINT social_posts_created_by_token_name_check
        CHECK ((created_by_token_id IS NULL OR created_by_token_name IS NOT NULL)
               AND (created_by_token_name IS NULL OR btrim(created_by_token_name) <> ''));
