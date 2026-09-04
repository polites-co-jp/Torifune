'use client';

import type { CSSProperties } from 'react';

/**
 * スイッチ（06_画面設計.md §32、028 設計 §7.4.2）。
 *
 * **`role="switch"` と `aria-checked` を持つ `<button>`。** チェックボックスと違い
 * 「押した瞬間に効く」設定に使う（Bot を集計に含める、など）。
 *
 * 状態は持たない制御コンポーネント。`onClick` は root に置き、`disabled` の判定も
 * ハンドラの中で行う（DOM 無しの環境でも挙動を確かめられるように）。
 */

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

const TRACK: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  flexShrink: 0,
  width: 'var(--tf-space-8)',
  height: 'var(--tf-space-4)',
  borderRadius: 'var(--tf-radius-pill)',
  transition: 'background 0.15s',
};

const THUMB: CSSProperties = {
  position: 'absolute',
  top: 'var(--tf-space-1)',
  left: 'var(--tf-space-1)',
  width: 'var(--tf-space-2)',
  height: 'var(--tf-space-2)',
  borderRadius: 'var(--tf-radius-pill)',
  background: 'var(--tf-color-primary-text)',
  transition: 'transform 0.15s',
};

export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (disabled) {
          return;
        }
        onChange(!checked);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--tf-space-2)',
        padding: 0,
        border: 'none',
        background: 'transparent',
        font: 'inherit',
        color: 'var(--tf-color-text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          ...TRACK,
          background: checked ? 'var(--tf-color-primary)' : 'var(--tf-color-border)',
        }}
      >
        <span
          style={{
            ...THUMB,
            transform: checked ? 'translateX(var(--tf-space-4))' : 'none',
          }}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}
