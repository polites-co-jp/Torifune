-- 定期実行ジョブの実行記録（029-scheduled-jobs 設計 §5）。
--
-- ジョブごとに最新 50 件だけ持つ（古い行はアプリが消す。§5.2）。
-- 監視・診断のための小さな表であり、履歴の長期保管はしない。
--
-- **新しい Permission は作らない。** 実行状況の参照は既存の `system.manage`。
--
-- **戻すとき**（ランナーは前進のみ。手で戻す場合）: DROP TABLE job_runs;
-- 他の表から参照されていないので、そのまま落とせる。
CREATE TABLE job_runs (
    id            uuid        PRIMARY KEY,
    -- 'analytics.rollup' / 'webhook.deliver'（domain/jobs/job.ts の JOB_NAMES）
    job_name      text        NOT NULL,
    -- 'scheduled'（本体の定期実行）/ 'manual'（API から）
    triggered_by  text        NOT NULL,
    -- 'running' → 'ok' / 'error'。ロックが取れなかったときは 'skipped'
    status        text        NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    -- 例外のメッセージだけ。スタックトレース・SQL・接続情報を入れない
    error         text,
    -- 結果の概要（rollup: from / to / days / points、webhook: attempted / delivered / failed）
    summary       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- 実行したプロセス（hostname:pid）。複数プロセス構成でどれが動いたかを見る
    runner        text,

    CONSTRAINT job_runs_job_name_not_blank CHECK (btrim(job_name) <> ''),
    CONSTRAINT job_runs_triggered_by_check CHECK (triggered_by IN ('scheduled', 'manual')),
    CONSTRAINT job_runs_status_check CHECK (status IN ('running', 'ok', 'error', 'skipped')),
    CONSTRAINT job_runs_finished_after_started CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT job_runs_error_length CHECK (error IS NULL OR char_length(error) <= 2000)
);

-- 「ジョブ × 新しい順」で引く。前回の実行・前回の成功・保持件数の切り詰めがすべてこれを使う。
CREATE INDEX job_runs_job_started_idx ON job_runs (job_name, started_at DESC);
