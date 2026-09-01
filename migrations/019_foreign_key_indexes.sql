-- 参照側に索引の無い外部キーへ索引を張る（02_データベース設計.md §12）
--
-- **PostgreSQL は外部キーの参照側に索引を自動生成しない。**
-- 索引が無いと、参照先の行を消すたびに参照側の全走査が起きる。
-- ここでは users を1人消すだけで sites / campaigns / plugin_operations を
-- 全部読むことになる。
--
-- 001_initial.sql:67-73,82 では同種の外部キーに索引を張っており、
-- あとから足したテーブルだけが揃っていなかった。

CREATE INDEX IF NOT EXISTS idx_sites_created_by ON sites (created_by);

CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON campaigns (created_by);

CREATE INDEX IF NOT EXISTS idx_plugin_operations_requested_by
    ON plugin_operations (requested_by);
