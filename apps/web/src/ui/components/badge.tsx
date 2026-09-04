import type { ReactNode } from 'react';

/**
 * バッジ（06_画面設計.md §32、028 設計 §7.4.2）。
 *
 * 状態を短い語で示す（「計測タグ未設置」、投稿の状態など）。
 * 意味は色だけに頼らず、必ず文字を持つ。
 */

export type BadgeTone = 'neutral' | 'success' | 'danger' | 'warning';

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
}

const TONE_COLOR: Record<Exclude<BadgeTone, 'neutral'>, string> = {
  success: 'var(--tf-color-success)',
  danger: 'var(--tf-color-danger)',
  warning: 'var(--tf-color-warning)',
};

export function Badge({ children, tone = 'neutral' }: BadgeProps) {
  const color = tone === 'neutral' ? 'var(--tf-color-text-muted)' : TONE_COLOR[tone];
  const background =
    tone === 'neutral'
      ? 'var(--tf-color-surface-strong)'
      : `color-mix(in srgb, ${color} 12%, var(--tf-color-bg))`;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: 'var(--tf-space-1) var(--tf-space-3)',
        borderRadius: 'var(--tf-radius-pill)',
        fontSize: 'var(--tf-text-label)',
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        color,
        background,
      }}
    >
      {children}
    </span>
  );
}
