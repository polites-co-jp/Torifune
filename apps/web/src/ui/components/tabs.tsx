import Link from 'next/link';

/**
 * タブ（06_画面設計.md §32）。
 *
 * これまで設定画面が Link でその場に実装しており、
 * **他の画面でタブが要るたびに同じものが増える**状態だった。
 *
 * 選択状態を URL に持つ。持たないと、リロードで先頭タブへ戻り、
 * タブを指したリンクも共有できない。
 */

export interface TabItem {
  readonly key: string;
  readonly label: string;
  /** その利用者に見せるか。権限で出し分ける（§29）。 */
  readonly visible?: boolean;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly current: string;
  /** タブを切り替えるリンクの組み立て。 */
  readonly hrefFor: (key: string) => string;
  readonly label: string;
}

export function Tabs({ items, current, hrefFor, label }: TabsProps) {
  const visible = items.filter((item) => item.visible !== false);

  return (
    <nav
      aria-label={label}
      style={{
        display: 'flex',
        gap: 'var(--tf-space-4)',
        borderBottom: '1px solid var(--tf-color-border)',
        marginBottom: 'var(--tf-space-4)',
        flexWrap: 'wrap',
      }}
    >
      {visible.map((item) => {
        const active = item.key === current;
        return (
          <Link
            key={item.key}
            href={hrefFor(item.key)}
            aria-current={active ? 'page' : undefined}
            style={{
              padding: 'var(--tf-space-2) 0',
              color: active ? 'var(--tf-color-text)' : 'var(--tf-color-text-muted)',
              borderBottom: active
                ? 'var(--tf-border-emphasis) solid var(--tf-color-primary)'
                : 'var(--tf-border-emphasis) solid transparent',
              textDecoration: 'none',
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
