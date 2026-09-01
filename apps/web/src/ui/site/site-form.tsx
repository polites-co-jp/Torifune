'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
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
  /**
   * フォームの脇に出すもの（`site.edit.sidebar` の描画結果）。
   *
   * **ここは Client Component なので、拡張点を自分で描けない。**
   * Server Component 側で描いたものを受け取る。
   * 渡されなければ脇の欄そのものを作らず、フォームを全幅にする。
   */
  readonly sidebar?: ReactNode;
}

export function SiteForm({ title, initial, siteId, sidebar }: SiteFormProps) {
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
          // **脇に出すものが無ければ2カラムにしない。**
          // 常に2カラムにしていたため、Plugin が何も足していない環境でも
          // フォームが半分の幅に押し込まれ、右は空のままだった。
          gridTemplateColumns: sidebar === undefined ? '1fr' : '1fr var(--tf-size-form)',
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

        {/* Plugin が編集画面の脇に足した欄（06_画面設計.md §26）。 */}
        {sidebar !== undefined && <aside>{sidebar}</aside>}
      </div>
    </>
  );
}
