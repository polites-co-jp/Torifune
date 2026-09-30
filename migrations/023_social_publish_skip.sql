-- 配信できない予約を後ろへ送る（035-social-publishing 設計 §5.1.1 / §6.5.2、要件 §4 裁定 #9）。
--
-- 022 で入れた `next_attempt_at` は「送って失敗したので待つ」ための列で、取り出し条件
-- （next_attempt_at IS NULL OR next_attempt_at <= now()）は既にこれを見ている。**SQL は変えない。**
-- 足すのは「なぜ・何回 飛ばしたか」を持つ 2 列だけで、飛ばすときに next_attempt_at を置いて後ろへ送る。
--
-- **`attempt_count` を流用しない。** あれは publish() を呼んだ回数で、飛ばした行では 0 のままという
-- 約束がある。「支度が整っていないので触らなかった」と「送って失敗した」は別の事象である。
--
-- 既存行はすべて skip_count = 0・skip_reason = NULL になり、意味は変わらない。
-- **新しいテーブル・Permission は作らない。索引も足さない**（取り出しは 022 までと同じ）。
--
-- **戻すとき**（手で戻す場合）: ALTER TABLE social_posts DROP COLUMN skip_count, DROP COLUMN skip_reason;
ALTER TABLE social_posts
    -- 同じ理由で続けて飛ばした回数。理由が変われば 1 から数え直す。
    ADD COLUMN skip_count  integer NOT NULL DEFAULT 0,
    -- どの理由で飛ばしたか。NULL なら飛ばされていない。Domain の SkipReason と 1 対 1。
    ADD COLUMN skip_reason text,
    ADD CONSTRAINT social_posts_skip_count_check CHECK (skip_count >= 0),
    ADD CONSTRAINT social_posts_skip_reason_check
        CHECK (skip_reason IS NULL
               OR skip_reason IN ('no_publisher', 'credential_missing', 'account_missing'));
