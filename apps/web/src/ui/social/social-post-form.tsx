'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { canTransition, isPostStatus, type PostStatus } from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, FormField, Input, Select, Textarea } from '@/ui/components';
import { POST_STATUS_LABEL } from '@/ui/social/labels';

/**
 * SNS投稿の作成・編集フォーム。
 *
 * 型B（フォーム画面）の実装（`02_画面デザイン方針.md` §4）。
 * `007-sites` の `SiteForm` と同じ形にしてある。
 *
 * **状態の選択肢は Domain の遷移規則から作る**（`canTransition`）。
 * ここで独自に列挙すると、「画面には出るが保存すると 422」という
 * 食い違いが出る。規則は Domain に1つだけ置く。
 */

export interface AccountOption {
  readonly id: string;
  readonly label: string;
}

export interface SocialPostFormValues {
  readonly socialAccountId: string;
  readonly body: string;
  /**
   * 予約日時。**ISO 文字列のまま受け取る。**
   *
   * `datetime-local` はローカル時刻を扱うが、サーバーとブラウザの
   * タイムゾーンは一致しない（コンテナは UTC、利用者は JST など）。
   * サーバー側で整形すると、利用者には別の時刻が見える。
   */
  readonly scheduledAtIso: string | null;
  readonly status: PostStatus;
}

export interface SocialPostFormProps {
  readonly title: string;
  readonly initial: SocialPostFormValues;
  readonly accounts: readonly AccountOption[];
  /** 新規なら undefined。 */
  readonly postId?: string;
}

/** ローカル時刻の `datetime-local` 値を、API へ渡せる ISO 文字列にする。 */
function toIsoOrNull(local: string): string | null {
  if (local === '') {
    return null;
  }
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO 文字列を `datetime-local` が読む形（`YYYY-MM-DDTHH:mm`）へ、閲覧者の時刻で直す。 */
function toLocalInputValue(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function SocialPostForm({ title, initial, accounts, postId }: SocialPostFormProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, readonly string[]>>({});
  const [busy, setBusy] = useState(false);

  // 変換はブラウザの時刻で行う必要があるため、描画後に入れる。
  // 初期描画からサーバーと違う値を出すと hydration が食い違う。
  const [scheduledAt, setScheduledAt] = useState('');
  useEffect(() => {
    setScheduledAt(toLocalInputValue(initial.scheduledAtIso));
  }, [initial.scheduledAtIso]);

  // 新規はどの状態からでも作れる。編集は現在の状態から進める先だけを出す。
  // `published` / `failed` は自分自身しか残らない（起きた事実は書き換えない）。
  const statusOptions = (Object.keys(POST_STATUS_LABEL) as PostStatus[]).filter((status) =>
    postId === undefined
      ? status === 'draft' || status === 'scheduled'
      : canTransition(initial.status, status),
  );
  const locked = postId !== undefined && statusOptions.length <= 1;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setBusy(true);

    const form = new FormData(event.currentTarget);
    // 状態を変えられない投稿では Select を disabled にしてあり、FormData に入らない。
    // ここで既定値へ落とすと published → draft を送ってしまい 422 になる。
    const status = String(form.get('status') ?? initial.status);
    const common = {
      body: String(form.get('body') ?? ''),
      scheduledAt: toIsoOrNull(String(form.get('scheduledAt') ?? '')),
      status: isPostStatus(status) ? status : 'draft',
    };

    const result =
      postId === undefined
        ? await apiRequest('/api/v1/social/posts', {
            method: 'POST',
            body: { ...common, socialAccountId: String(form.get('socialAccountId') ?? '') },
          })
        : await apiRequest(`/api/v1/social/posts/${postId}`, { method: 'PATCH', body: common });

    if (result.ok) {
      window.location.assign('/social');
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

      <div style={{ marginBottom: 'var(--tf-space-4)' }}>
        {/*
          出さないと「投稿したつもりで配信されていない」という誤解が起きる。
          外部SNSとの連携は Plugin の責務（01_アーキテクチャ設計.md §12）。
        */}
        <Alert tone="info">
          ここで登録するのは投稿の内容と予定です。実際の配信は、連携プラグインが行います。
        </Alert>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr var(--tf-size-form)',
          gap: 'var(--tf-space-6)',
        }}
      >
        <form onSubmit={onSubmit}>
          <FormField
            label="アカウント"
            required
            {...(fieldErrors['socialAccountId'] === undefined
              ? {}
              : { errors: fieldErrors['socialAccountId'] })}
          >
            {(props) => (
              <Select
                {...props}
                name="socialAccountId"
                defaultValue={initial.socialAccountId}
                required
                // 投稿先の付け替えは履歴の意味を変えるので、編集では変えさせない。
                disabled={postId !== undefined}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField
            label="本文"
            required
            {...(fieldErrors['body'] === undefined ? {} : { errors: fieldErrors['body'] })}
          >
            {(props) => (
              <Textarea {...props} name="body" defaultValue={initial.body} rows={8} required />
            )}
          </FormField>

          <FormField
            label="予約日時"
            description="空欄なら予約しません。"
            {...(fieldErrors['scheduledAt'] === undefined
              ? {}
              : { errors: fieldErrors['scheduledAt'] })}
          >
            {(props) => (
              <Input
                {...props}
                type="datetime-local"
                name="scheduledAt"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
            )}
          </FormField>

          <FormField
            label="状態"
            {...(locked
              ? {
                  description: `${POST_STATUS_LABEL[initial.status]}になった投稿は状態を戻せません。`,
                }
              : {})}
            {...(fieldErrors['status'] === undefined ? {} : { errors: fieldErrors['status'] })}
          >
            {(props) => (
              <Select {...props} name="status" defaultValue={initial.status} disabled={locked}>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {POST_STATUS_LABEL[status]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <div style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
            <Button type="submit" variant="primary" disabled={busy}>
              保存
            </Button>
            <Button variant="secondary" onClick={() => window.location.assign('/social')}>
              キャンセル
            </Button>
          </div>
        </form>

        <aside>
          {/*
            型B のサイドバー（02_画面デザイン方針.md §4）。
            Plugin の Extension Point（social.edit.sidebar）の位置を確保しておく。
            デザインを詰めるときに位置が消えないよう、先に枠を置く。
          */}
        </aside>
      </div>
    </>
  );
}
