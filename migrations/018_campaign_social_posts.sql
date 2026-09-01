-- キャンペーンとSNS投稿の関連、および配信結果の記録（06_画面設計.md §13, §14）
--
-- 設計: docs/設計/026-screen-completion/設計.md §3.1, §4.2

-- キャンペーンとSNS投稿の関連。
--
-- **campaign_sites と同じ流儀にそろえる**（013_campaigns.sql）。
-- 同じ形のものを違う形で作らない。
--
-- 多対多にする。1つのキャンペーンが複数の投稿を持つのは普通で、
-- 逆に1つの投稿が複数のキャンペーンに属するのも普通（同じ告知を
-- 別の取り組みからも数えたい、という運用がある）。
CREATE TABLE campaign_social_posts (
    campaign_id    uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    -- 投稿を消したら関連も消える。**キャンペーン自体は残す。**
    -- 対象が減っただけで、取り組みの記録は消さない（campaign_sites と同じ判断）。
    social_post_id uuid NOT NULL REFERENCES social_posts (id) ON DELETE CASCADE,

    PRIMARY KEY (campaign_id, social_post_id)
);

-- 「この投稿はどのキャンペーンのものか」を引く。
CREATE INDEX campaign_social_posts_post_idx ON campaign_social_posts (social_post_id);

-- 配信に失敗した時刻。
--
-- `published_at` はあるのに、失敗側に対応する列が無かった。
-- `updated_at` は「最後に触った時刻」であって「失敗した時刻」ではない。
-- 履歴を結果の時系列で並べるには、失敗にも時刻が要る。
--
-- **既存行へ遡って値を入れない。** 無かった記録を後から作らない。
-- 読み出し側が COALESCE で updated_at まで落とす。
ALTER TABLE social_posts ADD COLUMN failed_at timestamptz;

-- 履歴画面（配信結果が確定した投稿の一覧）の並び。
-- 結果が確定していない投稿は履歴に出ないので、部分索引にする。
CREATE INDEX social_posts_delivery_idx
    ON social_posts (COALESCE(published_at, failed_at, updated_at) DESC)
    WHERE status IN ('published', 'failed');
