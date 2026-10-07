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
  Modal,
  Select,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import {
  changeTokenSiteRequestBody,
  removedTokenScopes,
  TOKEN_SITE_CHANGE_LABEL,
  TOKEN_SITE_CHANGE_SUBMIT,
  TOKEN_SITE_CHANGE_TITLE,
  TOKEN_SITE_CHANGED,
  TOKEN_SITE_COMMON_INFO,
  TOKEN_SITE_COMMON_OPTION,
  TOKEN_SITE_DESCRIPTION,
  TOKEN_SITE_EMPTY_SCOPES_NOTE,
  TOKEN_SITE_MOVE_NOTE,
  tokenSiteLabel,
  tokenSiteRemovedScopesWarning,
  type TokenSiteOption,
} from '@/ui/settings/api-token-site';
import { SITE_COLUMN_HEADER } from '@/ui/social/labels';

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

/** サイトの `Select` の「共通」の値（送るときは null）。 */
const SITE_COMMON_VALUE = '';

/** 「サイトを変える」の Modal を開いたときの選択（今の値。選択肢に無ければ「共通」）。 */
function initialTokenSiteChoice(
  choices: readonly TokenSiteOption[],
  token: ApiTokenResponse | undefined,
): string {
  const current = token?.siteId ?? null;
  return current !== null && choices.some((site) => site.id === current)
    ? current
    : SITE_COMMON_VALUE;
}

const EXPIRY_OPTIONS = [
  { value: '30', label: '30日' },
  { value: '90', label: '90日' },
  { value: '365', label: '1年' },
  { value: '', label: '無期限' },
] as const;

export function ApiSettings({
  scopeCandidates,
  corsOrigins,
  sites,
  siteTokenScopes,
  initialSiteId,
  initialTokens,
  initialChangingTokenId,
}: {
  /** 発行者が持っている Permission。これを超える Scope は指定できない。 */
  readonly scopeCandidates: readonly string[];
  readonly corsOrigins: readonly string[];
  /**
   * サイトの一覧（053-site-scoped-social 設計 §9.2）。`site.read` が無ければ空で、「サイト」は「共通」だけ。
   * `active` / `paused` を名前順、続けてアーカイブを名前順に並べて渡す。部品は並べ替えない。
   */
  readonly sites: readonly TokenSiteOption[];
  /**
   * サイトのトークンに付けられる Scope（Domain の `SITE_TOKEN_SCOPES`）。
   * **部品に一覧を持たない。** Server Component が渡す（設計 §9.2）。
   */
  readonly siteTokenScopes: readonly string[];
  /** 発行フォームの「サイト」の初期値。既定は共通（単体テストのため。Server Component は渡さない）。 */
  readonly initialSiteId?: string | null;
  /** 一覧の初期値。渡されたら最初の読み込みをしない（単体テストのため。設計 §9.2）。 */
  readonly initialTokens?: readonly ApiTokenResponse[];
  /** 「サイトを変える」の Modal を、このトークンについて開いた状態で描く（単体テストのため）。 */
  readonly initialChangingTokenId?: string;
}) {
  const [tokens, setTokens] = useState<readonly ApiTokenResponse[] | null>(initialTokens ?? null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('90');
  const [scopes, setScopes] = useState<readonly string[]>([]);

  // サイト（053 設計 §9.2）。発行フォームと「サイトを変える」の選択肢は `active` / `paused` のサイト。
  const siteChoices = sites.filter((site) => site.status !== 'archived');
  const [siteId, setSiteId] = useState<string>(initialSiteId ?? SITE_COMMON_VALUE);
  const siteSelected = siteId !== SITE_COMMON_VALUE;

  // 「サイトを変える」（設計 §9.2.1）。開くときに要求を出さない。行の値とサイトの一覧だけを使う。
  const [changingId, setChangingId] = useState<string | null>(initialChangingTokenId ?? null);
  const [changeSiteId, setChangeSiteId] = useState(() =>
    initialTokenSiteChoice(
      siteChoices,
      initialTokens?.find((token) => token.id === initialChangingTokenId),
    ),
  );
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const changing =
    changingId === null ? null : (tokens?.find((token) => token.id === changingId) ?? null);
  const changeTarget = changeSiteId === SITE_COMMON_VALUE ? null : changeSiteId;
  const changeRemoved =
    changing === null
      ? []
      : removedTokenScopes({
          siteId: changeTarget,
          currentScopes: changing.scopes,
          siteTokenScopes,
        });
  const changeEmptiesScopes =
    changing !== null &&
    changeRemoved.length > 0 &&
    changeRemoved.length === changing.scopes.length;

  const reload = useCallback(async () => {
    const result = await apiRequest<readonly ApiTokenResponse[]>('/api/v1/api-tokens');
    if (result.ok) {
      setTokens(result.data);
    } else {
      setError(result.error.message);
    }
  }, []);

  // 一覧の初期値を受け取ったら最初の読み込みをしない（設計 §9.2）。
  const loadOnMount = initialTokens === undefined;
  useEffect(() => {
    if (loadOnMount) {
      void reload();
    }
  }, [reload, loadOnMount]);

  /** 発行フォームのサイトを選ぶ。サイトを選んだら、サイトのトークンに付けられない権限を外す（設計 §9.2）。 */
  function selectSite(value: string): void {
    setSiteId(value);
    if (value !== SITE_COMMON_VALUE) {
      setScopes((current) => current.filter((scope) => siteTokenScopes.includes(scope)));
    }
  }

  function openChange(token: ApiTokenResponse): void {
    setChangeSiteId(initialTokenSiteChoice(siteChoices, token));
    setChangeError(null);
    setChangingId(token.id);
  }

  function closeChange(): void {
    setChangingId(null);
    setChangeError(null);
  }

  /** 「サイトを変える」の送信（設計 §9.2.1）。失敗したら Modal は開いたまま。 */
  async function onChangeSite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const target = changing;
    if (target === null) return;
    setChangeError(null);
    setChangeBusy(true);

    const result = await apiRequest(`/api/v1/api-tokens/${target.id}`, {
      method: 'PATCH',
      body: changeTokenSiteRequestBody({
        siteId: changeTarget,
        currentScopes: target.scopes,
        siteTokenScopes,
      }),
    });

    setChangeBusy(false);

    if (!result.ok) {
      setChangeError(result.error.message);
      return;
    }

    closeChange();
    setToast({ id: crypto.randomUUID(), tone: 'success', text: TOKEN_SITE_CHANGED });
    await reload();
  }

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
      body: { name, scopes, expiresAt, siteId: siteSelected ? siteId : null },
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setIssued(result.data.token);
    setName('');
    setScopes([]);
    setSiteId(SITE_COMMON_VALUE);
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
      key: 'site',
      header: SITE_COLUMN_HEADER,
      // サイトの名前／共通／削除されたサイト／サイト専用（053 設計 §9.2）。
      render: (token) => tokenSiteLabel(token, sites),
    },
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
          // 「サイトを変える」は失効していないトークンだけ。「失効させる」の左（053 設計 §9.2.1）。
          <span style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
            <Button variant="ghost" onClick={() => openChange(token)}>
              {TOKEN_SITE_CHANGE_LABEL}
            </Button>
            <Button variant="danger" onClick={() => setRevoking(token)}>
              失効させる
            </Button>
          </span>
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

          <FormField label={SITE_COLUMN_HEADER} description={TOKEN_SITE_DESCRIPTION}>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={siteId}
                onChange={(event) => selectSite(event.target.value)}
              >
                <option value={SITE_COMMON_VALUE}>{TOKEN_SITE_COMMON_OPTION}</option>
                {siteChoices.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          {!siteSelected && (
            <div style={{ marginBottom: 'var(--tf-space-4)' }}>
              <Alert tone="info">{TOKEN_SITE_COMMON_INFO}</Alert>
            </div>
          )}

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
                {scopeCandidates.map((scope) => {
                  // サイトを選んでいる間、サイトのトークンに付けられない権限は選ばせない（設計 §9.2）。
                  const unavailable = siteSelected && !siteTokenScopes.includes(scope);
                  return (
                    <label key={scope} style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
                      <input
                        type="checkbox"
                        checked={!unavailable && scopes.includes(scope)}
                        disabled={unavailable}
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
                  );
                })}
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

      <Modal open={changing !== null} title={TOKEN_SITE_CHANGE_TITLE} onClose={closeChange}>
        {changing !== null && (
          <form onSubmit={onChangeSite}>
            {changeError !== null && (
              <div style={{ marginBottom: 'var(--tf-space-4)' }}>
                <Alert tone="danger">{changeError}</Alert>
              </div>
            )}

            <FormField label={SITE_COLUMN_HEADER}>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={changeSiteId}
                  onChange={(event) => setChangeSiteId(event.target.value)}
                >
                  <option value={SITE_COMMON_VALUE}>{TOKEN_SITE_COMMON_OPTION}</option>
                  {siteChoices.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            {changeRemoved.length > 0 && (
              <div style={{ marginBottom: 'var(--tf-space-4)' }}>
                <Alert tone="warning">
                  <span style={{ display: 'block' }}>
                    {tokenSiteRemovedScopesWarning(changeRemoved)}
                  </span>
                  {changeEmptiesScopes && (
                    <span style={{ display: 'block' }}>{TOKEN_SITE_EMPTY_SCOPES_NOTE}</span>
                  )}
                </Alert>
              </div>
            )}

            <div style={{ marginBottom: 'var(--tf-space-4)' }}>
              <Alert tone="info">{TOKEN_SITE_MOVE_NOTE}</Alert>
            </div>

            <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={closeChange}>
                キャンセル
              </Button>
              <Button type="submit" variant="primary" disabled={changeBusy}>
                {TOKEN_SITE_CHANGE_SUBMIT}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
