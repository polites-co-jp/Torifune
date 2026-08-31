'use client';

import { useState } from 'react';
import type { AccountStatus } from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  FormField,
  Input,
  Modal,
  SecretField,
  Select,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import { ACCOUNT_STATUS_LABEL } from '@/ui/social/labels';
import { AsyncState } from '@/ui/states/async-state';

/** SNSアカウント一覧。型A（一覧画面）。 */

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  readonly status: string;
  readonly credentialConfigured: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  x: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  other: 'その他',
};

export interface SocialAccountsProps {
  readonly initialAccounts: readonly AccountRow[];
  readonly permissions: readonly string[];
}

export function SocialAccounts(props: SocialAccountsProps) {
  const [accounts, setAccounts] = useState(props.initialAccounts);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [credential, setCredential] = useState('');

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');

  async function submitCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const result = await apiRequest<AccountRow>('/api/v1/social/accounts', {
      method: 'POST',
      body: {
        provider: String(form.get('provider') ?? 'other'),
        displayName: String(form.get('displayName') ?? ''),
        handle: String(form.get('handle') ?? ''),
        // 平文はここでだけ扱う。応答には含まれない。
        credential,
        status: credential === '' ? 'disconnected' : 'connected',
      },
    });

    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }

    setAccounts((current) => [result.data, ...current]);
    setCreating(false);
    setCredential('');
    setToast({ id: result.data.id, text: '登録しました。', tone: 'success' });
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setDeleting(null);

    const result = await apiRequest(`/api/v1/social/accounts/${target.id}`, {
      method: 'DELETE',
      body: {},
    });

    if (result.ok) {
      setAccounts((current) => current.filter((account) => account.id !== target.id));
      setToast({ id: target.id, text: '削除しました。', tone: 'success' });
    } else {
      setToast({ id: target.id, text: result.error.message, tone: 'danger' });
    }
  }

  const columns: Column<AccountRow>[] = [
    {
      key: 'provider',
      header: 'サービス',
      width: '10rem',
      render: (account) => PROVIDER_LABEL[account.provider] ?? account.provider,
    },
    { key: 'displayName', header: '表示名', render: (account) => account.displayName },
    { key: 'handle', header: 'ハンドル', render: (account) => account.handle },
    {
      key: 'credential',
      header: '資格情報',
      width: '10rem',
      // **平文を出さない。** 設定済みかどうかだけを示す。
      render: (account) => (account.credentialConfigured ? '••••••••' : '未設定'),
    },
    {
      key: 'status',
      header: '状態',
      width: '8rem',
      render: (account) => ACCOUNT_STATUS_LABEL[account.status as AccountStatus] ?? account.status,
    },
    {
      key: 'actions',
      header: '操作',
      width: '8rem',
      render: (account) =>
        canDelete ? (
          <Button variant="ghost" onClick={() => setDeleting(account)}>
            削除
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--tf-space-4)',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>SNS</h1>
        {canWrite && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            + アカウントを追加
          </Button>
        )}
      </header>

      <div style={{ marginBottom: 'var(--tf-space-4)' }}>
        {/*
          出さないと「投稿したつもりで配信されていない」という誤解が起きる。
          外部SNSとの連携は Plugin の責務（01_アーキテクチャ設計.md §12）。
        */}
        <Alert tone="info">
          とりふねは投稿の登録と管理までを行います。実際の配信は、連携プラグインが行います。
        </Alert>
      </div>

      <AsyncState
        status={accounts.length === 0 ? 'empty' : 'ready'}
        emptyMessage="SNSアカウントが登録されていません。"
        emptyAction={
          canWrite ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              アカウントを追加
            </Button>
          ) : undefined
        }
      >
        <Card>
          <Table columns={columns} rows={accounts} rowKey={(account) => account.id} />
        </Card>
      </AsyncState>

      <Modal open={creating} title="SNSアカウントを追加" onClose={() => setCreating(false)}>
        {formError !== null && (
          <div style={{ marginBottom: 'var(--tf-space-4)' }}>
            <Alert tone="danger">{formError}</Alert>
          </div>
        )}
        <form onSubmit={submitCreate}>
          <FormField label="サービス">
            {(fieldProps) => (
              <Select {...fieldProps} name="provider" defaultValue="x">
                <option value="x">X</option>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="youtube">YouTube</option>
                <option value="other">その他</option>
              </Select>
            )}
          </FormField>

          <FormField label="表示名" required>
            {(fieldProps) => <Input {...fieldProps} name="displayName" required />}
          </FormField>

          <FormField label="ハンドル" description="@ から始まる識別子など">
            {(fieldProps) => <Input {...fieldProps} name="handle" />}
          </FormField>

          <SecretField
            label="資格情報（アクセストークン等）"
            configured={false}
            onChange={setCredential}
            placeholder="保存後は再表示されません"
          />

          <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary">
              追加
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="SNSアカウントを削除しますか？"
        message={
          deleting === null
            ? ''
            : `「${deleting.displayName}」を削除します。関連する投稿もすべて削除されます。`
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
