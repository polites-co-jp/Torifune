-- キャンペーン（02_データベース設計.md §5.7、06_画面設計.md §14）
--
-- 設計: docs/設計/017-campaigns/設計.md

CREATE TABLE campaigns (
    id          uuid        PRIMARY KEY,
    name        text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    status      text        NOT NULL DEFAULT 'draft',
    -- キャンペーンを他の取り組みと分けるのは期間。時刻までは持たない
    -- （分単位で管理する運用は考えにくく、タイムゾーンの扱いが増えるだけ）。
    starts_on   date        NOT NULL,
    -- 終わりを決めずに始める運用があるため NULL を許す。
    ends_on     date,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- 作成者を消してもキャンペーンは残す（sites と同じ扱い）。
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,

    CONSTRAINT campaigns_status_check CHECK (status IN ('draft', 'running', 'finished', 'cancelled')),
    CONSTRAINT campaigns_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT campaigns_name_length CHECK (char_length(name) <= 200),
    -- 逆転を許すと、一覧の並びも期間の計算も壊れる。
    CONSTRAINT campaigns_period_order CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX campaigns_created_at_idx ON campaigns (created_at DESC);
CREATE INDEX campaigns_status_idx ON campaigns (status);
CREATE INDEX campaigns_name_lower_idx ON campaigns (lower(name));
-- 「いま実施中のもの」を引く。
CREATE INDEX campaigns_period_idx ON campaigns (starts_on, ends_on);

-- キャンペーンと Webサイトの関連（06_画面設計.md §14）。
--
-- 多対多にする。1つのキャンペーンが複数サイトにまたがるのは普通で、
-- 逆に1サイトが複数キャンペーンの対象になるのも普通。
CREATE TABLE campaign_sites (
    campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    -- サイトを消したら関連も消える。**キャンペーン自体は残す。**
    -- 対象が減っただけで、取り組みの記録は消さない。
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,

    PRIMARY KEY (campaign_id, site_id)
);

-- 「このサイトが対象のキャンペーン」を引く。
CREATE INDEX campaign_sites_site_idx ON campaign_sites (site_id);

-- Permission は site.* と同じ粒度にそろえる。
INSERT INTO permissions (name, display_name, description, is_system) VALUES
    ('campaign.read',   'キャンペーンの参照', 'キャンペーンの一覧と詳細を表示できる', true),
    ('campaign.write',  'キャンペーンの編集', 'キャンペーンを作成・更新できる',       true),
    ('campaign.delete', 'キャンペーンの削除', 'キャンペーンを削除できる',             true);

-- administrator は全部。
INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000001', 'campaign.read'),
    ('01900000-0000-7000-8000-000000000001', 'campaign.write'),
    ('01900000-0000-7000-8000-000000000001', 'campaign.delete');

-- editor は参照と編集（site.* と同じ考え方）。
INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000002', 'campaign.read'),
    ('01900000-0000-7000-8000-000000000002', 'campaign.write');

-- viewer は参照のみ。
INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000003', 'campaign.read');
