'use client';

import { useState, type FormEvent } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, FormField, Input, Select, Textarea } from '@/ui/components';

/**
 * Webサイトの作成・編集フォーム。
 *
 * 型B（フォーム画面）の実装（`02_画面デザイン方針.md` §4）。
 */

export interface SiteFormValues {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly status: string;
}

export interface SiteFormProps {
  readonly title: string;
  readonly initial: SiteFormValues;
  /** 新規なら undefined。 */
  readonly siteId?: string;
}

export function SiteForm({ title, initial, siteId }: SiteFormProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, readonly string[]>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name') ?? ''),
      url: String(form.get('url') ?? ''),
      description: String(form.get('description') ?? ''),
      status: String(form.get('status') ?? 'active'),
    };

    const result =
      siteId === undefined
        ? await apiRequest('/api/v1/sites', { method: 'POST', body })
        : await apiRequest(`/api/v1/sites/${siteId}`, { method: 'PATCH', body });

    if (result.ok) {
      window.location.assign('/sites');
      return;
    }

    setMessage(result.error.message);
    setFieldErrors(result.error.details ?? {});
    setBusy(false);
  }

  return (
    <>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>{title}</h1>

      {message !== null && (
        <div style={{ marginBottom: 'var(--tf-space-4)' }}>
          <Alert tone="danger">{message}</Alert>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr var(--tf-size-form)',
          gap: 'var(--tf-space-6)',
        }}
      >
        <form onSubmit={onSubmit}>
          <FormField
            label="名前"
            required
            {...(fieldErrors['name'] === undefined ? {} : { errors: fieldErrors['name'] })}
          >
            {(props) => <Input {...props} name="name" defaultValue={initial.name} required />}
          </FormField>

          <FormField
            label="URL"
            description="http:// または https:// で始まるURL"
            required
            {...(fieldErrors['url'] === undefined ? {} : { errors: fieldErrors['url'] })}
          >
            {(props) => <Input {...props} name="url" defaultValue={initial.url} required />}
          </FormField>

          <FormField
            label="説明"
            {...(fieldErrors['description'] === undefined
              ? {}
              : { errors: fieldErrors['description'] })}
          >
            {(props) => (
              <Textarea {...props} name="description" defaultValue={initial.description} />
            )}
          </FormField>

          <FormField label="状態">
            {(props) => (
              <Select {...props} name="status" defaultValue={initial.status}>
                <option value="active">稼働中</option>
                <option value="paused">停止中</option>
                <option value="archived">アーカイブ</option>
              </Select>
            )}
          </FormField>

          <div style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
            <Button type="submit" variant="primary" disabled={busy}>
              保存
            </Button>
            <Button variant="secondary" onClick={() => window.location.assign('/sites')}>
              キャンセル
            </Button>
          </div>
        </form>

        <aside>
          {/*
            Plugin の Extension Point（site.edit.sidebar）用の位置を確保しておく。
            デザインを詰めるときに消えないよう、先に枠を置く。
            実装は 011-plugin-runtime。
          */}
        </aside>
      </div>
    </>
  );
}
