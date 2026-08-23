'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

/**
 * 認証まわりの最低限のフォーム。
 *
 * `005-ui-shell` で共通コンポーネントへ載せ替える前提の、素朴な実装。
 * 色・余白は CSS 変数のみを参照する（後からデザインを差し替えられるようにするため）。
 */

export interface Field {
  readonly name: string;
  readonly label: string;
  readonly type: 'text' | 'password' | 'email';
  readonly autoComplete?: string;
}

export interface AuthFormProps {
  readonly title: string;
  readonly submitLabel: string;
  readonly fields: readonly Field[];
  readonly endpoint: string;
  /** 成功時の遷移先。 */
  readonly redirectTo: string;
  readonly footer?: ReactNode;
}

interface ApiError {
  error?: { code?: string; message?: string };
}

export function AuthForm(props: AuthFormProps) {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/auth/csrf')
      .then((response) => response.json())
      .then((body: { data?: { csrfToken?: string } }) => {
        if (!cancelled && typeof body.data?.csrfToken === 'string') {
          setCsrfToken(body.data.csrfToken);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessage('通信に失敗しました。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const payload: Record<string, string> = { csrfToken: csrfToken ?? '' };
    for (const field of props.fields) {
      payload[field.name] = String(form.get(field.name) ?? '');
    }

    try {
      const response = await fetch(props.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken ?? '' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        window.location.assign(props.redirectTo);
        return;
      }

      // サーバーが返した表示用メッセージだけを出す。
      // 内部の詳細を画面へ出さない（06_画面設計.md §34）。
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setMessage(body.error?.message ?? 'エラーが発生しました。');
    } catch {
      setMessage('通信に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: '360px',
        margin: '0 auto',
        padding: 'var(--tf-space-8) var(--tf-space-4)',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--tf-space-2)' }}>とりふね</h1>
      <h2
        style={{
          fontSize: '1rem',
          color: 'var(--tf-color-text-muted)',
          marginBottom: 'var(--tf-space-6)',
        }}
      >
        {props.title}
      </h2>

      {message !== null && (
        <p
          role="alert"
          style={{
            border: '1px solid var(--tf-color-danger)',
            borderRadius: 'var(--tf-radius-md)',
            padding: 'var(--tf-space-3)',
            marginBottom: 'var(--tf-space-4)',
            color: 'var(--tf-color-danger)',
          }}
        >
          {message}
        </p>
      )}

      <form onSubmit={onSubmit}>
        {props.fields.map((field) => (
          <div key={field.name} style={{ marginBottom: 'var(--tf-space-4)' }}>
            <label
              htmlFor={field.name}
              style={{ display: 'block', marginBottom: 'var(--tf-space-1)' }}
            >
              {field.label}
            </label>
            <input
              id={field.name}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              required
              style={{
                width: '100%',
                padding: 'var(--tf-space-2)',
                border: '1px solid var(--tf-color-border)',
                borderRadius: 'var(--tf-radius-md)',
              }}
            />
          </div>
        ))}

        <button
          type="submit"
          disabled={busy || csrfToken === null}
          style={{
            width: '100%',
            padding: 'var(--tf-space-3)',
            background: 'var(--tf-color-primary)',
            color: 'var(--tf-color-primary-text)',
            border: 'none',
            borderRadius: 'var(--tf-radius-md)',
            cursor: busy ? 'progress' : 'pointer',
          }}
        >
          {props.submitLabel}
        </button>
      </form>

      {props.footer !== undefined && (
        <div style={{ marginTop: 'var(--tf-space-6)' }}>{props.footer}</div>
      )}
    </main>
  );
}
