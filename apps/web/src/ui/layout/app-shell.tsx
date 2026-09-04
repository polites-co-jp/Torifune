import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import { collectMenus } from '@/plugin/registry';
import { NavLink } from './nav-link';
import { CORE_NAVIGATION, visibleNavigation, type NavigationItem } from './navigation';

/**
 * ログイン後の共通レイアウト（06_画面設計.md §7）。
 *
 * サービス名は既定でひらがなの「とりふね」（同 §2-11）。
 * **設定で変えられる**（06 §16 の一般タブ）。本番と検証を見分けるため。
 * ここで読むのは、ページごとに渡すと必ずどこかで渡し忘れるから。
 */

export interface AppShellProps {
  readonly displayName: string;
  readonly permissions: ReadonlySet<string>;
  readonly children: ReactNode;
}

export async function AppShell({ displayName, permissions, children }: AppShellProps) {
  const { serviceName } = await loadSystemSettings();

  // Plugin が追加した項目を Core の項目のあとに並べる。
  // Plugin が既存の項目を押しのけないよう、順序は Core を先にする。
  const pluginItems: NavigationItem[] = collectMenus(permissions).map((menu) => ({
    label: menu.label,
    href: menu.route,
    permission: menu.permission ?? null,
  }));

  const items = [...visibleNavigation(CORE_NAVIGATION, permissions), ...pluginItems];

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        background: 'var(--tf-color-surface)',
      }}
    >
      <header
        className="tf-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          // 高さは globals.css の .tf-header（--tf-size-header）。
          padding: 'var(--tf-space-2) var(--tf-space-6)',
          flexWrap: 'wrap',
          gap: 'var(--tf-space-2)',
          background: 'var(--tf-color-bg)',
          borderBottom: '1px solid var(--tf-color-border)',
        }}
      >
        <Link
          href="/dashboard"
          style={{ color: 'var(--tf-color-text)', fontWeight: 600, textDecoration: 'none' }}
        >
          {serviceName}
        </Link>

        <div style={{ display: 'flex', gap: 'var(--tf-space-4)', alignItems: 'center' }}>
          <span style={{ color: 'var(--tf-color-text-muted)' }}>{displayName}</span>
          <Link href="/logout" style={{ color: 'var(--tf-color-primary)' }}>
            ログアウト
          </Link>
        </div>
      </header>

      {/* レイアウトは globals.css の .tf-* で切り替える（@media はインラインで書けない）。 */}
      <div className="tf-shell">
        <nav aria-label="メインナビゲーション" className="tf-nav">
          <ul className="tf-nav-list">
            {items.map((item) => (
              <li key={item.href} className="tf-nav-item">
                {/* 選択中の判定（aria-current）は NavLink が現在のパスから行う。 */}
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
          {/* Plugin が追加した項目は上の一覧に含まれている（011-plugin-runtime）。 */}
        </nav>

        <main className="tf-main">{children}</main>
      </div>

      <footer
        style={{
          padding: 'var(--tf-space-3) var(--tf-space-6)',
          background: 'var(--tf-color-bg)',
          borderTop: '1px solid var(--tf-color-border)',
          color: 'var(--tf-color-text-muted)',
          fontSize: 'var(--tf-text-caption)',
        }}
      >
        {serviceName}
      </footer>
    </div>
  );
}
