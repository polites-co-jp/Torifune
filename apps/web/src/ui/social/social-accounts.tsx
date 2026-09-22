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

/**
 * 資格情報の入力欄の宣言（035-social-publishing 設計 §7.5）。
 *
 * **`kind` の違いは入力欄の見え方だけ。** 保存はどの項目も暗号化され、
 * どの項目も再表示されない（設計 §5.7）。
 */
export interface ProviderCredentialField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'secret';
}

/**
 * 「サービス」の選択肢。
 *
 * **部品の中に固定の一覧を持たない。** Core が知る provider に加えて、
 * publisher を登録した Plugin の provider が並ぶ。Server Component が組む（設計 §7.5）。
 */
export interface ProviderOption {
  readonly value: string;
  readonly label: string;
  readonly credentialFields: readonly ProviderCredentialField[];
}

export interface SocialAccountsProps {
  readonly initialAccounts: readonly AccountRow[];
  readonly permissions: readonly string[];
  readonly providers: readonly ProviderOption[];
  /**
   * 追加の Modal を開いた状態で描く。既定は false（Server Component は渡さない）。
   *
   * 単体テストの環境には DOM が無く、ボタンを押して開けないため。
   */
  readonly initialCreating?: boolean;
}

export function SocialAccounts(props: SocialAccountsProps) {
  const [accounts, setAccounts] = useState(props.initialAccounts);
  const [creating, setCreating] = useState(props.initialCreating === true);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [credential, setCredential] = useState('');
  const [provider, setProvider] = useState(props.providers[0]?.value ?? '');
  const [credentialValues, setCredentialValues] = useState<Readonly<Record<string, string>>>({});

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');

  const providerLabels: Readonly<Record<string, string>> = Object.fromEntries(
    props.providers.map((option) => [option.value, option.label]),
  );
  const credentialFields =
    props.providers.find((option) => option.value === provider)?.credentialFields ?? [];

  /** **入力値を持ち越さない。** 閉じたら捨てる（設計 §7.5）。 */
  function closeCreate(): void {
    setCreating(false);
    setCredential('');
    setCredentialValues({});
    setFormError(null);
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    // 項目ごとの欄があるときは `credentials`、無ければ従来どおり 1 つの `credential`。
    // **両方は送れない**（API が 422 にする。設計 §6.4）。
    const filled = Object.fromEntries(
      credentialFields
        .map((field) => [field.key, credentialValues[field.key] ?? ''] as const)
        .filter(([, value]) => value !== ''),
    );
    const configured =
      credentialFields.length === 0 ? credential !== '' : Object.keys(filled).length > 0;

    const result = await apiRequest<AccountRow>('/api/v1/social/accounts', {
      method: 'POST',
      body: {
        provider: String(form.get('provider') ?? provider),
        displayName: String(form.get('displayName') ?? ''),
        handle: String(form.get('handle') ?? ''),
        // 平文はここでだけ扱う。応答には含まれない。
        ...(credentialFields.length === 0 ? { credential } : { credentials: filled }),
        status: configured ? 'connected' : 'disconnected',
      },
    });

    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }

    setAccounts((current) => [result.data, ...current]);
    closeCreate();
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
      // publisher の表示名を優先する（設計 §5.6.1）。部品に自前の対応表を持たない。
      render: (account) => providerLabels[account.provider] ?? account.provider,
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

      <Modal open={creating} title="SNSアカウントを追加" onClose={closeCreate}>
        {formError !== null && (
          <div style={{ marginBottom: 'var(--tf-space-4)' }}>
            <Alert tone="danger">{formError}</Alert>
          </div>
        )}
        <form onSubmit={submitCreate}>
          <FormField label="サービス">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                name="provider"
                value={provider}
                onChange={(event) => {
                  // provider が変われば資格情報の形も変わる。入力値を持ち越さない。
                  setProvider(event.target.value);
                  setCredentialValues({});
                  setCredential('');
                }}
              >
                {props.providers.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label="表示名" required>
            {(fieldProps) => <Input {...fieldProps} name="displayName" required />}
          </FormField>

          {/*
            説明に「識別子」と書かない。publisher が宣言する項目名（`credentialFields` の
            ラベル）と紛れる。ここは常に出る欄で、資格情報の欄ではない。
          */}
          <FormField label="ハンドル" description="@ から始まる名前など">
            {(fieldProps) => <Input {...fieldProps} name="handle" />}
          </FormField>

          {/*
            publisher が項目を宣言していれば項目ごとの欄、無ければ従来どおり 1 つの欄
            （設計 §7.5）。**保存後は再表示しない**（`06` §38）。
          */}
          {credentialFields.length === 0 ? (
            <SecretField
              label="資格情報（アクセストークン等）"
              configured={false}
              onChange={setCredential}
              placeholder="保存後は再表示されません"
            />
          ) : (
            credentialFields.map((field) =>
              field.kind === 'secret' ? (
                <SecretField
                  key={field.key}
                  label={field.label}
                  configured={false}
                  onChange={(value) =>
                    setCredentialValues((current) => ({ ...current, [field.key]: value }))
                  }
                  placeholder="保存後は再表示されません"
                />
              ) : (
                <FormField key={field.key} label={field.label}>
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={credentialValues[field.key] ?? ''}
                      autoComplete="off"
                      onChange={(event) =>
                        setCredentialValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  )}
                </FormField>
              ),
            )
          )}

          <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={closeCreate}>
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
