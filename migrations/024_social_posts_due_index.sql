-- 期限の来た予約の走査を索引のシークで進める（035-social-publishing 設計 §5.1.2 / §5.2 / §6.5.3）。
--
-- 005_social.sql の social_posts_status_scheduled_idx (status, scheduled_at) は
-- 「status で絞って scheduled_at を範囲で読む」までは効くが、ページを進めるキーセットの
-- 行比較 (scheduled_at, id) > (…, …) が索引に載らない。同じ scheduled_at の行が並ぶと、
-- その等値の塊を読み直してから id でフィルタすることになり、外部アプリが同じ時刻で
-- 一括登録した形でちょうど効かない。
--
-- id を第 3 キーに足すと、並び（ORDER BY scheduled_at ASC, id ASC）も比較も
-- そのまま索引のシークになる。
--
-- **既存の索引は消さない。** 取り出し以外（履歴・一覧）が使っており、
-- 消すと 005 まで遡って影響を確かめることになる。
-- **新しい列・テーブル・Permission は作らない。** 索引が 1 本増えるだけで、行の意味は変わらない。
--
-- **戻すとき**（手で戻す場合）: DROP INDEX IF EXISTS social_posts_due_idx;
CREATE INDEX IF NOT EXISTS social_posts_due_idx
    ON social_posts (status, scheduled_at, id);
