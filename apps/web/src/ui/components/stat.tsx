import type { ReactNode } from 'react';

/**
 * KPI タイル（06_画面設計.md §32、028 設計 §7.4.2）。
 *
 * ラベル・値・前期間比・注記を縦に積む。値は等幅で、桁が揃って比べやすい。
 * **前期間比の良し悪しは色だけでなく `data-tone` にも出す。** 色が見えなくても、
 * 検査からも、意味が取れる。
 */

export type StatTone = 'success' | 'danger' | 'muted';

export interface StatDelta {
  readonly text: string;
  readonly tone: StatTone;
}

export interface StatProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly delta?: StatDelta;
  readonly note?: ReactNode;
}

const TONE_COLOR: Record<StatTone, string> = {
  success: 'var(--tf-color-success)',
  danger: 'var(--tf-color-danger)',
  muted: 'var(--tf-color-text-subtle)',
};

export function Stat({ label, value, delta, note }: StatProps) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--tf-space-1)', minWidth: 0 }}
    >
      <span
        style={{
          fontSize: 'var(--tf-text-label)',
          fontWeight: 600,
          color: 'var(--tf-color-text-subtle)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--tf-font-mono)',
          fontSize: 'var(--tf-text-kpi)',
          fontWeight: 500,
          lineHeight: 1.1,
          color: 'var(--tf-color-text)',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </span>
      {(delta !== undefined || note !== undefined) && (
        <span
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--tf-space-2)',
            fontSize: 'var(--tf-text-caption)',
            color: 'var(--tf-color-text-subtle)',
          }}
        >
          {delta !== undefined && (
            <span
              data-tone={delta.tone}
              style={{ fontFamily: 'var(--tf-font-mono)', color: TONE_COLOR[delta.tone] }}
            >
              {delta.text}
            </span>
          )}
          {note !== undefined && <span>{note}</span>}
        </span>
      )}
    </div>
  );
}
