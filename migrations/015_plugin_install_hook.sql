-- Plugin の install() フックを1度だけ呼ぶための記録（03_プラグイン設計.md §12）。
--
-- 設計: docs/設計/020-plugin-registry/設計.md §2.5
--
-- 導入は再ビルドを伴うため、**導入の瞬間には Plugin のコードをまだ読み込めない**。
-- 読み込めるようになるのは再ビルド後の起動から。
-- そこで「install() を呼んだか」を持ち、最初の有効化の直前に1度だけ呼ぶ。

ALTER TABLE plugins ADD COLUMN installed_hook_at timestamptz;
