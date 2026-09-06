'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './primitives';

/**
 * Modal / ConfirmDialog / Toast / EmptyState / SecretField。
 */

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    // Escape で閉じられないダイアログは、キーボードだけの利用者を閉じ込める。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(0 0 0 / 40%)',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--tf-space-4)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          background: 'var(--tf-color-bg)',
          borderRadius: 'var(--tf-radius-2xl)',
          boxShadow: 'var(--tf-shadow-1)',
          padding: 'var(--tf-space-8)',
          maxWidth: 'var(--tf-size-dialog)',
          width: '100%',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 'var(--tf-text-h2)', fontWeight: 600 }}>{title}</h2>
        <div>{children}</div>
        {footer !== undefined && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--tf-space-2)',
              marginTop: 'var(--tf-space-6)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /**
   * `message` の下に足す本文（任意）。
   *
   * 1 行では足りない確認のためにある（消える件数の内訳、断り書きなど）。
   * **既存の props は変えない。** 渡さなければ現行と同じ HTML になる。
   */
  readonly children?: ReactNode;
}

/**
 * 不可逆な操作の確認（06_画面設計.md §37）。
 *
 * **確認ダイアログはセキュリティ対策ではない。** 誤操作を防ぐためのもの。
 * 権限の検証は必ずサーバー側で行う。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '削除する',
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            キャンセル
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{message}</p>
      {children}
      <p style={{ color: 'var(--tf-color-text-muted)', marginBottom: 0 }}>
        この操作は取り消せません。
      </p>
    </Modal>
  );
}

export interface ToastMessage {
  readonly id: string;
  readonly text: string;
  readonly tone?: 'info' | 'success' | 'danger';
}

export interface ToastProps {
  readonly message: ToastMessage | null;
  readonly onDismiss: () => void;
  /** 表示時間（ミリ秒）。 */
  readonly durationMs?: number;
}

export function Toast({ message, onDismiss, durationMs = 4000 }: ToastProps) {
  useEffect(() => {
    if (message === null) {
      return;
    }
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [message, onDismiss, durationMs]);

  if (message === null) {
    return null;
  }

  const color =
    message.tone === 'danger'
      ? 'var(--tf-color-danger)'
      : message.tone === 'success'
        ? 'var(--tf-color-success)'
        : 'var(--tf-color-text)';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'var(--tf-space-6)',
        right: 'var(--tf-space-6)',
        background: 'var(--tf-color-bg)',
        border: `1px solid ${color}`,
        borderRadius: 'var(--tf-radius-lg)',
        boxShadow: 'var(--tf-shadow-1)',
        padding: 'var(--tf-space-3) var(--tf-space-4)',
        color,
      }}
    >
      {message.text}
    </div>
  );
}

export interface EmptyStateProps {
  readonly message: string;
  /** 次に行う操作への導線（06_画面設計.md §35）。 */
  readonly action?: ReactNode;
}

export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 'var(--tf-space-8)',
        color: 'var(--tf-color-text-muted)',
      }}
    >
      <p>{message}</p>
      {action !== undefined && <div style={{ marginTop: 'var(--tf-space-4)' }}>{action}</div>}
    </div>
  );
}

export interface SecretFieldProps {
  readonly label: string;
  /** 値が設定済みか。**平文は受け取らない。** */
  readonly configured: boolean;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

/**
 * Secret の入力（06_画面設計.md §38）。
 *
 * **設定済みの値を再表示しない。** マスクした固定文字列を出すだけで、
 * 平文を DOM へ載せない。載せると、開発者ツールから読める。
 */
export function SecretField({ label, configured, onChange, placeholder }: SecretFieldProps) {
  const [editing, setEditing] = useState(!configured);

  if (!editing) {
    return (
      <div style={{ marginBottom: 'var(--tf-space-4)' }}>
        <span style={{ display: 'block', marginBottom: 'var(--tf-space-1)' }}>{label}</span>
        <div style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}>
          <span aria-label="設定済み" style={{ color: 'var(--tf-color-text-muted)' }}>
            ••••••••••••••••
          </span>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            変更する
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 'var(--tf-space-4)' }}>
      <label style={{ display: 'block', marginBottom: 'var(--tf-space-1)' }}>
        {label}
        <input
          type="password"
          autoComplete="off"
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
          style={{
            width: '100%',
            height: 'var(--tf-size-input)',
            padding: 'var(--tf-space-2) var(--tf-space-4)',
            border: '1px solid var(--tf-color-border)',
            borderRadius: 'var(--tf-radius-lg)',
            font: 'inherit',
            marginTop: 'var(--tf-space-1)',
          }}
        />
      </label>
    </div>
  );
}
