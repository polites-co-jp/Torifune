'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ApiTokenResponse } from '@/api/schemas/api-token';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  FormField,
  Input,
  Select,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';

/**
 * 設定 → API（06_画面設計.md §16、05_API設計.md §37-38）。
 *
 * **平文はここで一度だけ出す。** 保存されていないので、閉じたら二度と見られない。
 * そのことを画面で明言する。書いておかないと「あとで見られる」と思われる。
 *
 * CORS は環境変数で決まるため、ここでは変えられない。
 * 画面から変えられるようにすると、環境変数と食い違ったときに
 * どちらが効いているのか分からなくなる。
 */

const EXPIRY_OPTIONS = [
  { value: '30', label: '30日' },
  { value: '90', label: '90日' },
  { value: '365', label: '1年' },
  { value: '', label: '無期限' },
] as const;

export function ApiSettings({
  scopeCandidates,
  corsOrigins,
}: {
  /** 発行者が持っている Permission。これを超える Scope は指定できない。 */
  readonly scopeCandidates: readonly string[];
  readonly corsOrigins: readonly string[];
}) {
  const [tokens, setTokens] = useState<readonly ApiTokenResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('90');
  const [scopes, setScopes] = useState<readonly string[]>([]);

  const reload = useCallback(async () => {
    const result = await apiRequest<readonly ApiTokenResponse[]>('/api/v1/api-tokens');
    if (result.ok) {
      setTokens(result.data);
    } else {
      setError(result.error.message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onIssue(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const expiresAt =
      expiresInDays === ''
        ? null
        : new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000).toISOString();

    const result = await apiRequest<{ token: string }>('/api/v1/api-tokens', {
      method: 'POST',
      body: { name, scopes, expiresAt },
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setIssued(result.data.token);
    setName('');
    setScopes([]);
    await reload();
  }

  async function onRevoke(token: ApiTokenResponse): Promise<void> {
    const result = await apiRequest(`/api/v1/api-tokens/${token.id}`, { method: 'DELETE' });
    setRevoking(null);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setToast({ id: crypto.randomUUID(), tone: 'success', text: '失効させました。' });
    await reload();
  }

  const columns: readonly Column<ApiTokenResponse>[] = [
    { key: 'name', header: '名前', render: (token) => token.name },
    {
      key: 'prefix',
      header: '識別子',
      render: (token) => <code>{token.prefix}…</code>,
    },
    {
      key: 'scopes',
      header: '権限',
      render: (token) => (token.scopes.length === 0 ? '（なし）' : token.scopes.join(', ')),
    },
    {
      key: 'expiresAt',
      header: '有効期限',
      render: (token) =>
        token.expiresAt === null ? '無期限' : new Date(token.expiresAt).toLocaleDateString('ja-JP'),
    },
    {
      key: 'lastUsedAt',
      header: '最終利用',
      render: (token) =>
        token.lastUsedAt === null ? '未使用' : new Date(token.lastUsedAt).toLocaleString('ja-JP'),
    },
    {
      key: 'state',
      header: '状態',
      render: (token) =>
        token.revokedAt !== null ? (
          <span style={{ color: 'var(--tf-color-text-muted)' }}>失効済み</span>
        ) : (
          <Button variant="danger" onClick={() => setRevoking(token)}>
            失効させる
          </Button>
        ),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      {error !== null && <Alert tone="danger">{error}</Alert>}

      {issued !== null && (
        <Card>
          <Alert tone="warning">
            <strong>この値はこの画面でしか表示されません。</strong>
            保存していないため、閉じると二度と取り出せません。控えてから閉じてください。
          </Alert>
          <pre
            data-issued-token
            style={{
              background: 'var(--tf-color-surface)',
              border: '1px solid var(--tf-color-border)',
              borderRadius: 'var(--tf-radius-md)',
              padding: 'var(--tf-space-3)',
              overflowX: 'auto',
            }}
          >
            {issued}
          </pre>
          <Button onClick={() => setIssued(null)}>閉じる</Button>
        </Card>
      )}

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>APIトークンの発行</h2>

        <form onSubmit={onIssue}>
          <FormField label="名前" description="どこで使うトークンかが分かる名前を付けます。">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={name}
                required
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </FormField>

          <FormField label="有効期限">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.label} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField
            label="権限"
            description="トークンに許す操作を選びます。自分が持っていない権限は選べません。選ばなければ何もできません。"
          >
            {() => (
              <div style={{ display: 'grid', gap: 'var(--tf-space-1)' }}>
                {scopeCandidates.map((scope) => (
                  <label key={scope} style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(event) =>
                        setScopes((current) =>
                          event.target.checked
                            ? [...current, scope]
                            : current.filter((value) => value !== scope),
                        )
                      }
                    />
                    <code>{scope}</code>
                  </label>
                ))}
              </div>
            )}
          </FormField>

          <Button type="submit" variant="primary" disabled={busy}>
            発行する
          </Button>
        </form>
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>発行済みのトークン</h2>
        {tokens === null ? null : tokens.length === 0 ? (
          <EmptyState message="トークンはありません。上のフォームから発行できます。" />
        ) : (
          <Table columns={columns} rows={tokens} rowKey={(token) => token.id} />
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>API 仕様</h2>
        <p style={{ margin: 0 }}>
          <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>
        </p>
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>CORS</h2>
        <p style={{ margin: 0 }}>
          {corsOrigins.length === 0
            ? '許可している Origin はありません（外部サイトのブラウザから直接は呼べません）。'
            : `許可している Origin: ${corsOrigins.join(', ')}`}
        </p>
        <p style={{ color: 'var(--tf-color-text-muted)' }}>
          環境変数 <code>TORIFUNE_CORS_ORIGINS</code> で設定します。
          画面からは変更できません（設定が二重になると、どちらが効いているのか
          分からなくなるため）。
        </p>
      </Card>

      {revoking !== null && (
        <ConfirmDialog
          open
          title="トークンを失効させますか？"
          message={`「${revoking.name}」を使っている連携は動かなくなります。元に戻せません。`}
          confirmLabel="失効させる"
          onConfirm={() => void onRevoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      )}

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
