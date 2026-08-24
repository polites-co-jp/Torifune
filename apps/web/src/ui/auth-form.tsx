'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { apiRequest } from './client/api-client';
import { Alert, Button, FormField, Input } from './components';

/**
 * 認証まわりのフォーム。
 *
 * 共通コンポーネントと共通 API Client の上に載せている。
 * CSRF トークンの取得は API Client が受け持つため、ここには出てこない。
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

export function AuthForm(props: AuthFormProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, readonly string[]>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const payload: Record<string, string> = {};
    for (const field of props.fields) {
      payload[field.name] = String(form.get(field.name) ?? '');
    }

    const result = await apiRequest(props.endpoint, { method: 'POST', body: payload });

    if (result.ok) {
      window.location.assign(props.redirectTo);
      return;
    }

    // 表示文言は画面側で持つ。内部事情が混ざった文言を出さない。
    setMessage(result.error.message);
    setFieldErrors(result.error.details ?? {});
    setBusy(false);
  }

  return (
    <main
      style={{
        maxWidth: 'var(--tf-size-form)',
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
        <div style={{ marginBottom: 'var(--tf-space-4)' }}>
          <Alert tone="danger">{message}</Alert>
        </div>
      )}

      <form onSubmit={onSubmit}>
        {props.fields.map((field) => (
          <FormField
            key={field.name}
            label={field.label}
            required
            {...(fieldErrors[field.name] === undefined ? {} : { errors: fieldErrors[field.name] })}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                name={field.name}
                type={field.type}
                autoComplete={field.autoComplete}
                required
              />
            )}
          </FormField>
        ))}

        <Button type="submit" variant="primary" disabled={busy} style={{ width: '100%' }}>
          {props.submitLabel}
        </Button>
      </form>

      {props.footer !== undefined && (
        <div style={{ marginTop: 'var(--tf-space-6)' }}>{props.footer}</div>
      )}
    </main>
  );
}
