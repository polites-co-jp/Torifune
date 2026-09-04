'use client';

import type { InputHTMLAttributes } from 'react';

/**
 * 日付入力（06_画面設計.md §32）。
 *
 * **ブラウザ標準の `<input type="date">` を置き換えない。**
 * 置き換えると、キーボード操作・IME・地域ごとの表記を全部自前で持つことになり、
 * 標準より使いにくいものができる。
 *
 * 共通化するのは見た目（トークンに沿った枠と余白）だけ。
 */
export type DateFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function DateField(props: DateFieldProps) {
  return (
    <input
      {...props}
      type="date"
      style={{
        width: '100%',
        height: 'var(--tf-size-input)',
        padding: 'var(--tf-space-2) var(--tf-space-4)',
        border: '1px solid var(--tf-color-border)',
        borderRadius: 'var(--tf-radius-lg)',
        background: 'var(--tf-color-bg)',
        color: 'var(--tf-color-text)',
        font: 'inherit',
        ...props.style,
      }}
    />
  );
}
