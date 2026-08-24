-- Plugin の導入・削除の操作記録
--
-- **再起動を跨いで結果を伝えるために要る。**
-- 再ビルドの最中はプロセスが落ちているため、メモリ上の進行状況は消える。
--
-- 有効化・無効化はここに載せない。再ビルドが要らず、その場で終わる。
--
-- 設計: docs/設計/012-plugin-manager/設計.md §6

CREATE TABLE plugin_operations (
    id           uuid        PRIMARY KEY,
    plugin_id    text        NOT NULL,
    kind         text        NOT NULL,
    status       text        NOT NULL DEFAULT 'pending',
    message      text,
    -- 誰が要求したか。Plugin の導入はアプリへのコード導入にあたるため残す。
    requested_by uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,

    CONSTRAINT plugin_operations_kind_check CHECK (kind IN ('install', 'uninstall')),
    CONSTRAINT plugin_operations_status_check
        CHECK (status IN ('pending', 'restarting', 'succeeded', 'failed'))
);

-- 再起動後に「閉じていない操作」を探す。
CREATE INDEX plugin_operations_open_idx
    ON plugin_operations (started_at DESC)
    WHERE status IN ('pending', 'restarting');
