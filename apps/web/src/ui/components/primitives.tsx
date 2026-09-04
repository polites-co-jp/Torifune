'use client';

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * 共通コンポーネント（06_画面設計.md §32）。
 *
 * **色・余白・角丸は CSS 変数だけを参照する。**
 * 生の値を書くと、デザインを詰めるときにここを全部触ることになる。
 *
 * **props だけで見た目が決まる。** API 呼び出しも権限判定もここに入れない。
 * 入れると、デザイン変更のたびに業務ロジックを触ることになる。
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--tf-color-primary)',
    color: 'var(--tf-color-primary-text)',
    border: '1px solid var(--tf-color-primary)',
  },
  secondary: {
    background: 'var(--tf-color-bg)',
    color: 'var(--tf-color-text)',
    border: '1px solid var(--tf-color-border)',
  },
  danger: {
    background: 'var(--tf-color-danger)',
    color: 'var(--tf-color-primary-text)',
    border: '1px solid var(--tf-color-danger)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--tf-color-text)',
    border: '1px solid transparent',
  },
};

/** 押せない primary は色を落とす。半透明にすると下の面が透けて汚れる。 */
const DISABLED_PRIMARY: React.CSSProperties = {
  background: 'var(--tf-color-primary-disabled)',
  border: '1px solid var(--tf-color-primary-disabled)',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

export function Button({
  variant = 'secondary',
  style,
  disabled,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true;
  return (
    <button
      type="button"
      disabled={disabled}
      // hover はインラインでは書けない。globals.css の .tf-button-* が受け持つ。
      className={['tf-button', `tf-button-${variant}`, className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--tf-space-2)',
        minHeight: 'var(--tf-size-control)',
        padding: 'var(--tf-space-2) var(--tf-space-5)',
        borderRadius: 'var(--tf-radius-pill)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled && variant !== 'primary' ? 0.5 : 1,
        font: 'inherit',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...BUTTON_STYLES[variant],
        ...(isDisabled && variant === 'primary' ? DISABLED_PRIMARY : {}),
        ...style,
      }}
      {...rest}
    />
  );
}

const FIELD_STYLE: React.CSSProperties = {
  width: '100%',
  padding: 'var(--tf-space-2) var(--tf-space-4)',
  border: '1px solid var(--tf-color-border)',
  borderRadius: 'var(--tf-radius-lg)',
  background: 'var(--tf-color-bg)',
  color: 'var(--tf-color-text)',
  font: 'inherit',
};

/** 1 行の入力は高さを揃える。複数行（Textarea）は除く。 */
const SINGLE_LINE_FIELD_STYLE: React.CSSProperties = {
  ...FIELD_STYLE,
  height: 'var(--tf-size-input)',
};

export function Input({ style, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input style={{ ...SINGLE_LINE_FIELD_STYLE, ...style }} {...rest} />;
}

export function Textarea({ style, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={6}
      style={{ ...FIELD_STYLE, padding: 'var(--tf-space-3) var(--tf-space-4)', ...style }}
      {...rest}
    />
  );
}

export function Select({ style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select style={{ ...SINGLE_LINE_FIELD_STYLE, ...style }} {...rest} />;
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label: string;
}

export function Checkbox({ label, id, ...rest }: CheckboxProps) {
  return (
    <label
      htmlFor={id}
      style={{ display: 'inline-flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}
    >
      <input id={id} type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export interface CardProps {
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function Card({ title, actions, children }: CardProps) {
  return (
    <section
      style={{
        background: 'var(--tf-color-bg)',
        border: '1px solid var(--tf-color-border)',
        borderRadius: 'var(--tf-radius-2xl)',
        padding: 'var(--tf-space-8)',
      }}
    >
      {(title !== undefined || actions !== undefined) && (
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 'var(--tf-space-4)',
            flexWrap: 'wrap',
            marginBottom: 'var(--tf-space-4)',
          }}
        >
          <h2 style={{ fontSize: 'var(--tf-text-h2)', fontWeight: 600, margin: 0 }}>{title}</h2>
          <div>{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ALERT_COLOR: Record<AlertTone, string> = {
  info: 'var(--tf-color-primary)',
  success: 'var(--tf-color-success)',
  warning: 'var(--tf-color-warning)',
  danger: 'var(--tf-color-danger)',
};

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly children: ReactNode;
}

export function Alert({ tone = 'info', children }: AlertProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{
        border: `1px solid ${ALERT_COLOR[tone]}`,
        borderRadius: 'var(--tf-radius-lg)',
        padding: 'var(--tf-space-3) var(--tf-space-4)',
        color: ALERT_COLOR[tone],
      }}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = '読み込み中' }: { readonly label?: string }) {
  return (
    <span role="status" aria-live="polite" style={{ color: 'var(--tf-color-text-muted)' }}>
      {label}…
    </span>
  );
}
