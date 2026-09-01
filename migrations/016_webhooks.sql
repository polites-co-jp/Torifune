-- Webhook（05_API設計.md §39）
--
-- 設計: docs/設計/023-webhook/設計.md

CREATE TABLE webhooks (
    id         uuid        PRIMARY KEY,
    name       text        NOT NULL,
    url        text        NOT NULL,
    -- **暗号化済みの文字列**。平文を入れてはならない（02_データベース設計.md §13）。
    secret     text        NOT NULL,
    -- 送る Core イベント。空なら何も送らない。
    events     text[]      NOT NULL DEFAULT '{}',
    status     text        NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT webhooks_status_check CHECK (status IN ('active', 'paused')),
    CONSTRAINT webhooks_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT webhooks_url_scheme CHECK (url ~ '^https?://')
);

CREATE INDEX webhooks_status_idx ON webhooks (status);

-- 配信の予約と履歴。
--
-- **発火の場で送り切らない。** 受け手が落ちていると、Torifune の操作そのものが
-- 遅くなる／失敗する。予約だけして、あとで送る（設計 §3.4）。
CREATE TABLE webhook_deliveries (
    id              uuid        PRIMARY KEY,
    webhook_id      uuid        NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    event           text        NOT NULL,
    payload         jsonb       NOT NULL,
    status          text        NOT NULL DEFAULT 'pending',
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    -- 次に試してよい時刻。再試行の間隔を空けるため。
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT webhook_deliveries_status_check
        CHECK (status IN ('pending', 'delivered', 'failed'))
);

-- 送るべきものを引く。
CREATE INDEX webhook_deliveries_pending_idx
    ON webhook_deliveries (status, next_attempt_at)
    WHERE status = 'pending';

-- 履歴を新しい順に見る。
CREATE INDEX webhook_deliveries_webhook_idx
    ON webhook_deliveries (webhook_id, created_at DESC);
