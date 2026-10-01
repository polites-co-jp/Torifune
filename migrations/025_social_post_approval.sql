-- SNS 投稿の承認待ち（048-social-post-approval 設計 §5）。
--
-- 1. 状態に awaiting_approval（承認待ち）を足す。**既存の 4 値の意味は変えない。**
-- 2. 承認した時刻 approved_at を足す。承認を経た予約だけが値を持つ（承認を外す判定に使う。設計 §6.3.3）。
--    誰が承認したかは audit_logs に残す（列にはしない。設計 §5.2）。
-- 3. Permission social.approve を足し、administrator と editor に割り当てる（設計 §8）。
--
-- 既存行はすべて approved_at = NULL になり、意味は変わらない。索引は足さない（設計 §5.3）。
--
-- **戻すとき**（手で戻す場合。承認待ちの行が残っていれば先に draft へ移す）:
--   UPDATE social_posts SET status = 'draft' WHERE status = 'awaiting_approval';
--   ALTER TABLE social_posts DROP CONSTRAINT social_posts_approved_at_check, DROP COLUMN approved_at;
--   ALTER TABLE social_posts DROP CONSTRAINT social_posts_status_check,
--     ADD CONSTRAINT social_posts_status_check CHECK (status IN ('draft', 'scheduled', 'published', 'failed'));
--   DELETE FROM role_permissions WHERE permission_name = 'social.approve';
--   DELETE FROM permissions WHERE name = 'social.approve';
ALTER TABLE social_posts
    DROP CONSTRAINT social_posts_status_check,
    ADD CONSTRAINT social_posts_status_check
        CHECK (status IN ('draft', 'awaiting_approval', 'scheduled', 'published', 'failed')),
    ADD COLUMN approved_at timestamptz,
    -- 承認の記録を持てるのは、承認を経て予約になった行と、その結果（配信済み・失敗）だけ。
    ADD CONSTRAINT social_posts_approved_at_check
        CHECK (approved_at IS NULL OR status IN ('scheduled', 'published', 'failed'));

INSERT INTO permissions (name, display_name, description, is_system) VALUES
    ('social.approve', 'SNS投稿の承認', '承認待ちのSNS投稿を承認して配信に回せる', true);

INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000001', 'social.approve'),   -- administrator
    ('01900000-0000-7000-8000-000000000002', 'social.approve');   -- editor
