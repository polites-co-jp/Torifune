'use client';

import { useId, type ReactElement, type ReactNode } from 'react';

/**
 * ラベル・説明・エラー文言の枠。
 *
 * **エラーを `aria-invalid` と `aria-describedby` で結び付ける。**
 * 見た目だけでエラーを示すと、スクリーンリーダーの利用者に伝わらない。
 */

export interface FormFieldProps {
  readonly label: string;
  readonly description?: string;
  /** サーバーから返ったフィールド単位のエラー。 */
  readonly errors?: readonly string[];
  readonly required?: boolean;
  /** 入力要素。`id` と `aria-*` を差し込むため、関数で受け取る。 */
  readonly children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactElement;
}

export function FormField({
  label,
  description,
  errors,
  required,
  children,
}: FormFieldProps): ReactNode {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const hasError = errors !== undefined && errors.length > 0;

  const describedBy = [description === undefined ? null : descriptionId, hasError ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div style={{ marginBottom: 'var(--tf-space-4)' }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: 'var(--tf-space-1)' }}>
        {label}
        {required === true && (
          <span aria-hidden="true" style={{ color: 'var(--tf-color-danger)' }}>
            {' '}
            *
          </span>
        )}
      </label>

      {description !== undefined && (
        <p
          id={descriptionId}
          style={{
            margin: `0 0 var(--tf-space-1)`,
            color: 'var(--tf-color-text-muted)',
            fontSize: '0.875rem',
          }}
        >
          {description}
        </p>
      )}

      {children({
        id,
        'aria-invalid': hasError,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
      })}

      {hasError && (
        <ul
          id={errorId}
          style={{
            margin: `var(--tf-space-1) 0 0`,
            paddingLeft: 'var(--tf-space-4)',
            color: 'var(--tf-color-danger)',
            fontSize: '0.875rem',
          }}
        >
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
