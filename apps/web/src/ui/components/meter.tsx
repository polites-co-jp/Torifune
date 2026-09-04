/**
 * 横棒（06_画面設計.md §32、028 設計 §7.4.2）。
 *
 * 上位ページ・参照元・デバイスの割合、キャンペーンの進行に使う。
 * `role="meter"` と `aria-valuenow` で読み上げにも値を渡す。
 *
 * **`max` が 0 でも落ちない。** 0 で割ると NaN になり、幅の指定が壊れて棒が消える。
 */

export interface MeterProps {
  readonly value: number;
  readonly max: number;
  /** 何の割合かを読み上げへ伝える。 */
  readonly label?: string;
}

function percentOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export function Meter({ value, max, label }: MeterProps) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const safeMax = Number.isFinite(max) ? Math.max(max, 0) : 0;

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={safeValue}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      style={{
        width: '100%',
        height: 'var(--tf-space-2)',
        borderRadius: 'var(--tf-radius-pill)',
        background: 'var(--tf-color-surface-strong)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${percentOf(safeValue, safeMax)}%`,
          height: '100%',
          borderRadius: 'var(--tf-radius-pill)',
          background: 'var(--tf-color-primary)',
        }}
      />
    </div>
  );
}
