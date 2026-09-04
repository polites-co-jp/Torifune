import Link from 'next/link';

/**
 * セグメントコントロール（06_画面設計.md §32、028 設計 §7.4.2）。
 *
 * 期間プリセットのように、少数の選択肢から 1 つを選ぶ。
 * `Tabs` と同じく**選択状態を URL に持つ**。リロードしても、リンクを共有しても同じ画面になる。
 */

export interface SegmentedControlItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

export interface SegmentedControlProps {
  readonly items: readonly SegmentedControlItem[];
  /** 選択中の `key`。 */
  readonly current: string;
  /** 何を選ぶ操作かを読み上げへ伝える。 */
  readonly label: string;
}

export function SegmentedControl({ items, current, label }: SegmentedControlProps) {
  return (
    <nav
      aria-label={label}
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: 'var(--tf-space-1)',
        padding: 'var(--tf-space-1)',
        background: 'var(--tf-color-surface-strong)',
        borderRadius: 'var(--tf-radius-pill)',
      }}
    >
      {items.map((item) => {
        const active = item.key === current;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            style={{
              padding: 'var(--tf-space-1) var(--tf-space-3)',
              borderRadius: 'var(--tf-radius-pill)',
              fontSize: 'var(--tf-text-caption)',
              fontWeight: active ? 600 : 400,
              color: active ? 'var(--tf-color-text)' : 'var(--tf-color-text-muted)',
              background: active ? 'var(--tf-color-bg)' : 'transparent',
              boxShadow: active ? 'var(--tf-shadow-1)' : 'none',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
