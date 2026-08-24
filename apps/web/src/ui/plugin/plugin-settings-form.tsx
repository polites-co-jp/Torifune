'use client';

import { useState } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Card, FormField, Input, Toast, type ToastMessage } from '@/ui/components';

/**
 * Plugin の設定フォーム（06_画面設計.md §27, §38）。
 *
 * **Plugin は項目を宣言するだけ。フォームは本体が描く。**
 * Plugin ごとにフォームを書かせると、Secret の扱いが Plugin ごとに変わり、
 * どこかで平文が表に出る。
 */

export interface SettingsField {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly kind: 'text' | 'secret';
  readonly placeholder: string | null;
  readonly value: string | null;
  readonly configured: boolean;
}

export interface PluginSettingsFormProps {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly fields: readonly SettingsField[];
}

export function PluginSettingsForm(props: PluginSettingsFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.fields.map((field) => [field.key, field.value ?? ''])),
  );
  const [configured, setConfigured] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(props.fields.map((field) => [field.key, field.configured])),
  );
  const [errors, setErrors] = useState<Record<string, readonly string[]>>({});
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    setErrors({});

    const result = await apiRequest<{ saved: string[] }>(
      `/api/v1/plugins/${props.pluginId}/settings`,
      {
        method: 'PUT',
        body: { values },
      },
    );

    setBusy(false);

    if (!result.ok) {
      setErrors(result.error.details ?? {});
      setToast({ id: 'save', text: result.error.message, tone: 'danger' });
      return;
    }

    // Secret は保存後も平文を持たない。入力欄を空へ戻し、「設定済み」に切り替える。
    setValues((current) => {
      const next = { ...current };
      for (const field of props.fields) {
        if (field.kind === 'secret' && next[field.key] !== '') {
          next[field.key] = '';
        }
      }
      return next;
    });
    setConfigured((current) => {
      const next = { ...current };
      for (const key of result.data.saved) {
        next[key] = true;
      }
      return next;
    });

    setToast({ id: 'save', text: '保存しました。', tone: 'success' });
  }

  if (props.fields.length === 0) {
    return <Alert tone="info">この Plugin に設定項目はありません。</Alert>;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <Card title={`${props.pluginName} の設定`}>
        <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
          {props.fields.map((field) => (
            <FormField
              key={field.key}
              label={field.label}
              {...(field.description === null ? {} : { description: field.description })}
              {...(errors[field.key] === undefined ? {} : { errors: errors[field.key] })}
            >
              {(fieldProps) => (
                <div>
                  <Input
                    {...fieldProps}
                    type={field.kind === 'secret' ? 'password' : 'text'}
                    value={values[field.key] ?? ''}
                    placeholder={
                      field.kind === 'secret' && configured[field.key] === true
                        ? '設定済み（変更するときだけ入力）'
                        : (field.placeholder ?? '')
                    }
                    autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                  {field.kind === 'secret' && (
                    <p
                      style={{
                        margin: 'var(--tf-space-1) 0 0',
                        color: 'var(--tf-color-text-muted)',
                        fontSize: '0.875rem',
                      }}
                      data-testid={`secret-state-${field.key}`}
                    >
                      {configured[field.key] === true ? '設定済み' : '未設定'}
                    </p>
                  )}
                </div>
              )}
            </FormField>
          ))}
        </div>

        <div style={{ marginTop: 'var(--tf-space-4)' }}>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </Card>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
