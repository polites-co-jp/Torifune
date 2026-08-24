-- コンテンツを Core の責務から外す（docs/仕様書/改訂履歴.md 2026-08-24）
--
-- コンテンツ管理は Plugin の責務とし、Core は content.* の Permission を持たない。
-- コンテンツを扱う Plugin は、自身の Permission を Plugin ID の名前空間で登録する
-- （例: blog.post.read）。
--
-- 001_initial.sql は適用済みのため書き換えない。ここで取り下げる。

-- role_permissions は permission_name への FK で ON DELETE CASCADE なので、
-- permissions を消せば割り当ても消える。
DELETE FROM permissions WHERE name IN ('content.read', 'content.write', 'content.delete');

-- editor / viewer が Web サイトと SNS を扱えるよう、割り当てを補う。
-- 001 では content.* に寄っていた分を site.* / social.* で埋める。
INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000002', 'social.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000003', 'site.read'),
    ('01900000-0000-7000-8000-000000000003', 'social.read')
ON CONFLICT DO NOTHING;
