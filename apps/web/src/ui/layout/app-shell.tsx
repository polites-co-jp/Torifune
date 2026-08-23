import Link from 'next/link';
import type { ReactNode } from 'react';
import { CORE_NAVIGATION, visibleNavigation } from './navigation';

/**
 * ログイン後の共通レイアウト（06_画面設計.md §7）。
 *
 * サービス名は画面上ひらがなで「とりふね」（同 §2-11）。
 */

export interface AppShellProps {
  readonly displayName: string;
  readonly permissions: ReadonlySet<string>;
  readonly children: ReactNode;
}

export function AppShell({ displayName, permissions, children }: AppShellProps) {
  const items = visibleNavigation(CORE_NAVIGATION, permissions);

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
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: 'var(--tf-space-3) var(--tf-space-6)',
          background: 'var(--tf-color-bg)',
          borderBottom: '1px solid var(--tf-color-border)',
        }}
      >
        <Link href="/dashboard" style={{ color: 'var(--tf-color-text)', fontWeight: 600 }}>
          とりふね
        </Link>

        <div style={{ display: 'flex', gap: 'var(--tf-space-4)', alignItems: 'center' }}>
          <span style={{ color: 'var(--tf-color-text-muted)' }}>{displayName}</span>
          <Link href="/logout" style={{ color: 'var(--tf-color-primary)' }}>
            ログアウト
          </Link>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'var(--tf-size-nav) 1fr' }}>
        <nav
          aria-label="メインナビゲーション"
          style={{
            background: 'var(--tf-color-bg)',
            borderRight: '1px solid var(--tf-color-border)',
            padding: 'var(--tf-space-4)',
          }}
        >
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item) => (
              <li key={item.href} style={{ marginBottom: 'var(--tf-space-2)' }}>
                <Link
                  href={item.href}
                  style={{
                    display: 'block',
                    padding: 'var(--tf-space-2) var(--tf-space-3)',
                    borderRadius: 'var(--tf-radius-md)',
                    color: 'var(--tf-color-text)',
                  }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          {/*
            Plugin が追加するナビゲーション項目は、011-plugin-runtime でここへ差し込む。
            拡張点の位置を先に確保しておく（デザインを詰めるときに消えないように）。
          */}
        </nav>

        <main style={{ padding: 'var(--tf-space-6)' }}>{children}</main>
      </div>

      <footer
        style={{
          padding: 'var(--tf-space-3) var(--tf-space-6)',
          background: 'var(--tf-color-bg)',
          borderTop: '1px solid var(--tf-color-border)',
          color: 'var(--tf-color-text-muted)',
          fontSize: '0.875rem',
        }}
      >
        とりふね
      </footer>
    </div>
  );
}
