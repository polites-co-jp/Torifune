-- Permission 名にハイフンを許す
--
-- Plugin ID はハイフンを許す（seo-plugin）が、Permission 名は許していなかった。
-- そのため、Plugin が自分の ID を名前空間にした Permission
-- （seo-plugin.report.read）を登録できなかった。
--
-- 011-plugin-runtime のテストで発覚した。
-- 001_initial.sql は適用済みのため書き換えず、ここで制約を張り替える。

ALTER TABLE permissions DROP CONSTRAINT permissions_name_format;

ALTER TABLE permissions ADD CONSTRAINT permissions_name_format
    CHECK (name ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$');
