'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, FormField, Input, Select, Textarea } from '@/ui/components';

/**
 * キャンペーンの作成・編集フォーム（06_画面設計.md §14）。
 *
 * `site-form.tsx` と同じ形にそろえている。
 */

export interface CampaignFormValues {
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteIds: readonly string[];
  /** 紐づくSNS投稿（06_画面設計.md §14）。 */
  readonly socialPostIds: readonly string[];
}

export interface SiteOption {
  readonly id: string;
  readonly name: string;
}

/** 選択肢として出すSNS投稿。本文をそのまま出すと選べないので、抜粋にしてある。 */
export interface SocialPostOption {
  readonly id: string;
  readonly label: string;
}

export function CampaignForm({
  title,
  initial,
  sites,
  socialPosts,
  campaignId,
  sidebar,
}: {
  readonly title: string;
  readonly initial: CampaignFormValues;
  readonly sites: readonly SiteOption[];
  readonly socialPosts: readonly SocialPostOption[];
  /** 新規なら undefined。 */
  readonly campaignId?: string;
  /**
   * フォームの脇に出すもの（`campaign.edit.sidebar` の描画結果）。
   *
   * **ここは Client Component なので、拡張点を自分で描けない。**
   * Server Component 側で描いたものを受け取る（`site-form.tsx` と同じ形）。
   */
  readonly sidebar?: ReactNode;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, readonly string[]>>({});
  const [siteIds, setSiteIds] = useState<readonly string[]>(initial.siteIds);
  const [socialPostIds, setSocialPostIds] = useState<readonly string[]>(initial.socialPostIds);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const endsOn = String(form.get('endsOn') ?? '');

    const body = {
      name: String(form.get('name') ?? ''),
      description: String(form.get('description') ?? ''),
      status: String(form.get('status') ?? 'draft'),
      startsOn: String(form.get('startsOn') ?? ''),
      // 空欄は「終わりを決めない」。空文字のまま送ると日付として弾かれる。
      endsOn: endsOn === '' ? null : endsOn,
      siteIds,
      socialPostIds,
    };

    const result =
      campaignId === undefined
        ? await apiRequest('/api/v1/campaigns', { method: 'POST', body })
        : await apiRequest(`/api/v1/campaigns/${campaignId}`, { method: 'PATCH', body });

    if (result.ok) {
      window.location.assign('/campaigns');
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
          // 脇に出すものが無ければ2カラムにしない。空の欄で本体を狭くしない。
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
                <option value="draft">下書き</option>
                <option value="running">実施中</option>
                <option value="finished">終了</option>
                <option value="cancelled">中止</option>
              </Select>
            )}
          </FormField>

          <FormField
            label="開始日"
            required
            {...(fieldErrors['startsOn'] === undefined ? {} : { errors: fieldErrors['startsOn'] })}
          >
            {(props) => (
              <Input
                {...props}
                name="startsOn"
                type="date"
                defaultValue={initial.startsOn}
                required
              />
            )}
          </FormField>

          <FormField
            label="終了日"
            description="空欄なら終わりを決めずに続けます。"
            {...(fieldErrors['endsOn'] === undefined ? {} : { errors: fieldErrors['endsOn'] })}
          >
            {(props) => (
              <Input {...props} name="endsOn" type="date" defaultValue={initial.endsOn ?? ''} />
            )}
          </FormField>

          <FormField label="対象サイト" description="複数選べます。">
            {() =>
              sites.length === 0 ? (
                <p style={{ color: 'var(--tf-color-text-muted)', margin: 0 }}>
                  登録されたWebサイトがありません。
                </p>
              ) : (
                <div style={{ display: 'grid', gap: 'var(--tf-space-1)' }}>
                  {sites.map((site) => (
                    <label key={site.id} style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
                      <input
                        type="checkbox"
                        checked={siteIds.includes(site.id)}
                        onChange={(event) =>
                          setSiteIds((current) =>
                            event.target.checked
                              ? [...current, site.id]
                              : current.filter((id) => id !== site.id),
                          )
                        }
                      />
                      {site.name}
                    </label>
                  ))}
                </div>
              )
            }
          </FormField>

          <FormField
            label="関連するSNS投稿"
            description="このキャンペーンのために出す投稿を選びます。複数選べます。"
          >
            {() =>
              socialPosts.length === 0 ? (
                <p style={{ color: 'var(--tf-color-text-muted)', margin: 0 }}>
                  選べるSNS投稿がありません。
                </p>
              ) : (
                <div style={{ display: 'grid', gap: 'var(--tf-space-1)' }}>
                  {socialPosts.map((post) => (
                    <label key={post.id} style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
                      <input
                        type="checkbox"
                        checked={socialPostIds.includes(post.id)}
                        onChange={(event) =>
                          setSocialPostIds((current) =>
                            event.target.checked
                              ? [...current, post.id]
                              : current.filter((id) => id !== post.id),
                          )
                        }
                      />
                      {post.label}
                    </label>
                  ))}
                </div>
              )
            }
          </FormField>

          <div style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
            <Button type="submit" variant="primary" disabled={busy}>
              保存
            </Button>
            <Button variant="secondary" onClick={() => window.location.assign('/campaigns')}>
              キャンセル
            </Button>
          </div>
        </form>

        {sidebar !== undefined && <aside>{sidebar}</aside>}
      </div>
    </>
  );
}
