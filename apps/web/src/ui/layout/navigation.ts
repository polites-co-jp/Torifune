import type { PermissionName } from '@/domain/permission';

/**
 * ナビゲーション定義（06_画面設計.md §8）。
 *
 * 各項目に必要な Permission を持たせる。持たないユーザーには表示しない。
 * **ただしそれは認可ではない。** サーバー側で必ず検証する（同 §29-30）。
 *
 * Plugin からの項目追加は `011-plugin-runtime` でここへ繋ぐ。
 */

export interface NavigationItem {
  readonly label: string;
  readonly href: string;
  /** null なら誰でも見える。 */
  readonly permission: PermissionName | null;
}

/**
 * **画面が存在する項目だけを載せる。**
 *
 * 画面が無いうちから項目を置くと、権限を持つユーザーがクリックしたときに
 * 404 になる。行き先の画面があることは `ui-shell.test.ts` で検査している。
 *
 * 「設定」の中身（`06_画面設計.md` §16 の 一般 / ユーザー / 権限 / 認証 / API）は
 * `015-settings` で作る。いまは Plugin のタブを載せる器だけがある。
 */
export const CORE_NAVIGATION: readonly NavigationItem[] = [
  { label: 'ダッシュボード', href: '/dashboard', permission: null },
  { label: 'Webサイト', href: '/sites', permission: 'site.read' },
  { label: 'SNS', href: '/social', permission: 'social.read' },
  { label: '設定', href: '/settings', permission: 'user.manage' },
  { label: 'プラグイン', href: '/plugins', permission: 'plugin.manage' },
];

/** 表示してよい項目だけに絞る。 */
export function visibleNavigation(
  items: readonly NavigationItem[],
  permissions: ReadonlySet<string>,
): readonly NavigationItem[] {
  return items.filter((item) => item.permission === null || permissions.has(item.permission));
}
