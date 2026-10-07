'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ownValue } from '@/domain/own-value';
import type { SiteStatus } from '@/domain/site/site';
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
import {
  buildClearCredentialRequest,
  buildCreateAccountRequest,
  buildSetCredentialRequest,
  credentialInputOf,
  type CredentialInput,
} from '@/ui/social/credential-form';
import {
  ACCOUNT_STATUS_LABEL,
  CREDENTIAL_CLEAR_CONFIRM_LABEL,
  CREDENTIAL_CLEAR_CONFIRM_TITLE,
  CREDENTIAL_CLEAR_LABEL,
  CREDENTIAL_CLEARED,
  CREDENTIAL_FIELDS_NOTE,
  CREDENTIAL_FREE_NOTE,
  CREDENTIAL_GENERIC_FIELD_LABEL,
  CREDENTIAL_NONE_NOTE,
  CREDENTIAL_NONE_WARNING,
  CREDENTIAL_SAVED,
  CREDENTIAL_SET_LABEL,
  CREDENTIAL_STATE_CONFIGURED,
  CREDENTIAL_STATE_NOT_CONFIGURED,
  credentialClearMessage,
  credentialTargetLabel,
  SITE_CHANGE_LABEL,
  SITE_CHANGE_TITLE,
  SITE_CHANGE_WARNING,
  SITE_CHANGED,
  SITE_COLUMN_HEADER,
  SITE_COMMON_LABEL,
  SITE_COMMON_OPTION,
  SITE_FILTER_ALL,
  SITE_FILTER_LABEL,
  SITE_SELECT_DESCRIPTION,
  SITE_SELECT_NO_PERMISSION,
  SITE_UNNAMED_LABEL,
  siteNameLabel,
} from '@/ui/social/labels';
import { HelpLink } from '@/ui/help/help-link';
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
 * 一覧が受け取る行（053-site-scoped-social 設計 §9.1.5）。`AccountRow` に属するサイトを足したもの。
 *
 * `siteId` は null で共通、**省略も共通と同じ**（既存の行の組み立てを壊さない）。
 * `AccountRow` のキーは資格情報を混ぜないための検査（039 #24）が型でちょうど固定しているので、
 * 資格情報ではないサイトは別の型で足す。
 */
export type AccountRowWithSite = AccountRow & { readonly siteId?: string | null };

/**
 * 部品が受け取るサイト（053 設計 §9.1.5）。Server Component が `listSites` から組み、
 * `active` / `paused` を名前順、続けてアーカイブを名前順に並べて渡す。部品は並べ替えない。
 */
export interface SiteOption {
  readonly id: string;
  readonly name: string;
  readonly status: SiteStatus;
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
  /** publisher が宣言した説明。欄の下に出す（039 設計 §7.1.2）。省略・空文字なら出さない。 */
  readonly description?: string;
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
  /** この provider に publisher が登録されているか。省略は false（039 設計 §7.1）。 */
  readonly publisherRegistered?: boolean;
  /**
   * この provider の publisher を登録している Plugin の、先頭の手順書（041-plugin-help-docs 設計 §7.4）。
   * 無ければ省略。
   */
  readonly help?: { readonly href: string; readonly title: string };
}

export interface SocialAccountsProps {
  readonly initialAccounts: readonly AccountRowWithSite[];
  readonly permissions: readonly string[];
  readonly providers: readonly ProviderOption[];
  /**
   * 追加の Modal を開いた状態で描く。既定は false（Server Component は渡さない）。
   *
   * 単体テストの環境には DOM が無く、ボタンを押して開けないため。
   */
  readonly initialCreating?: boolean;
  /**
   * 資格情報の入れ直しの Modal を、このアカウントについて開いた状態で描く。
   * 既定は閉じる（Server Component は渡さない）。`initialCreating` と同じ理由（039 設計 §10.4）。
   */
  readonly initialEditingAccountId?: string;
  /** サイトの一覧（053 設計 §9.1.5）。`site.read` が無ければ空。既定は空。 */
  readonly sites?: readonly SiteOption[];
  /** `site.read` を持つか。無ければサイトを選ばせない（設計 §9.1.2・§9.1.3）。既定は false。 */
  readonly canReadSites?: boolean;
  /**
   * 「サイトの紐づけを変える」の Modal を、このアカウントについて開いた状態で描く。
   * 既定は閉じる（Server Component は渡さない）。`initialCreating` と同じ理由（053 設計 §9.1.5）。
   */
  readonly initialSiteEditingAccountId?: string;
  /** 「サイトで絞り込む」の初期値。既定は「すべて」（Server Component は渡さない）。 */
  readonly initialSiteFilter?: string;
}

/** 絞り込みの「すべて」と「共通」の値（サイトの ID は UUID なので重ならない）。 */
const SITE_FILTER_ALL_VALUE = '';
const SITE_FILTER_COMMON_VALUE = 'common';

/** サイトの `Select` の「共通」の値（送るときは null）。 */
const SITE_COMMON_VALUE = '';

/** 行のサイト。省略は共通と同じ（設計 §9.1.5）。 */
function siteIdOf(account: AccountRowWithSite): string | null {
  return account.siteId ?? null;
}

/**
 * 「サイトの紐づけを変える」の選択肢（設計 §9.1.3）：追加の Modal と同じ `active` / `paused` のサイトに、
 * 今の値がアーカイブしたサイトならそれも足す。
 */
function siteChoicesFor(
  sites: readonly SiteOption[],
  currentSiteId: string | null,
): readonly SiteOption[] {
  return sites.filter(
    (site) => site.status !== 'archived' || (currentSiteId !== null && site.id === currentSiteId),
  );
}

/** Modal を開いたときの選択（今の値。選択肢に無ければ「共通」）。 */
function initialSiteChoice(
  sites: readonly SiteOption[],
  account: AccountRowWithSite | undefined,
): string {
  const current = account === undefined ? null : siteIdOf(account);
  if (current === null) return SITE_COMMON_VALUE;
  return siteChoicesFor(sites, current).some((site) => site.id === current)
    ? current
    : SITE_COMMON_VALUE;
}

/** 空文字の説明は「無い」として渡す（039 設計 §7.1.2。空の要素や空の参照を残さない）。 */
function descriptionOf(field: ProviderCredentialField): string | undefined {
  return field.description === undefined || field.description === ''
    ? undefined
    : field.description;
}

/**
 * 資格情報の入力の場に出すヘルプボタン（041 設計 §7.4.1）。
 *
 * 入力の形が `fields` / `none`（publisher がある）で、その Plugin が手順書を宣言しているときだけ。
 * `free`（publisher が無い）はどの Plugin の手順書か分からないので出さない。
 */
function helpOfInput(
  option: ProviderOption | undefined,
  input: CredentialInput,
): ProviderOption['help'] | undefined {
  return input === 'free' ? undefined : option?.help;
}

interface CredentialFieldsProps {
  readonly fields: readonly ProviderCredentialField[];
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (key: string, value: string) => void;
}

/**
 * publisher が宣言した項目ごとの欄（035 設計 §7.5、039 設計 §7.1.2）。
 *
 * **保存後は再表示しない**（`06` §38）。どの欄も空で始まる。
 */
function CredentialFields({ fields, values, onChange }: CredentialFieldsProps) {
  return (
    <>
      {fields.map((field) =>
        field.kind === 'secret' ? (
          <SecretField
            key={field.key}
            label={field.label}
            configured={false}
            onChange={(value) => onChange(field.key, value)}
            placeholder="保存後は再表示されません"
            description={descriptionOf(field)}
          />
        ) : (
          <FormField key={field.key} label={field.label} description={descriptionOf(field)}>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={values[field.key] ?? ''}
                autoComplete="off"
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
          </FormField>
        ),
      )}
    </>
  );
}

export function SocialAccounts(props: SocialAccountsProps) {
  const router = useRouter();
  const [accounts, setAccounts] = useState(props.initialAccounts);
  const [creating, setCreating] = useState(props.initialCreating === true);
  const [deleting, setDeleting] = useState<AccountRowWithSite | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [credential, setCredential] = useState('');
  const [provider, setProvider] = useState(props.providers[0]?.value ?? '');
  const [credentialValues, setCredentialValues] = useState<Readonly<Record<string, string>>>({});

  // 資格情報の入れ直し（039 設計 §7.3）。開くときに要求を出さない。状態は行の値だけを使う。
  const [editingId, setEditingId] = useState<string | null>(props.initialEditingAccountId ?? null);
  const [editValues, setEditValues] = useState<Readonly<Record<string, string>>>({});
  const [editCredential, setEditCredential] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  // サイト（053 設計 §9.1）。開くときに要求を出さない。行の値とサイトの一覧だけを使う。
  const sites = props.sites ?? [];
  const canReadSites = props.canReadSites === true;
  const [createSiteId, setCreateSiteId] = useState(SITE_COMMON_VALUE);
  const [siteEditingId, setSiteEditingId] = useState<string | null>(
    props.initialSiteEditingAccountId ?? null,
  );
  const [siteEditValue, setSiteEditValue] = useState(() =>
    initialSiteChoice(
      sites,
      props.initialAccounts.find((account) => account.id === props.initialSiteEditingAccountId),
    ),
  );
  const [siteEditError, setSiteEditError] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState(props.initialSiteFilter ?? SITE_FILTER_ALL_VALUE);

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');

  const providerLabels: Readonly<Record<string, string>> = Object.fromEntries(
    props.providers.map((option) => [option.value, option.label]),
  );
  const optionOf = (value: string): ProviderOption | undefined =>
    props.providers.find((option) => option.value === value);

  const createOption = optionOf(provider);
  const createInput = credentialInputOf(createOption);
  const createHelp = helpOfInput(createOption, createInput);
  const credentialFields = createOption?.credentialFields ?? [];

  const editing = editingId === null ? null : (accounts.find((a) => a.id === editingId) ?? null);
  const editOption = editing === null ? undefined : optionOf(editing.provider);
  const editInput: CredentialInput = credentialInputOf(editOption);
  const editHelp = helpOfInput(editOption, editInput);
  const editFields = editInput === 'fields' ? (editOption?.credentialFields ?? []) : [];

  const siteEditing =
    siteEditingId === null ? null : (accounts.find((a) => a.id === siteEditingId) ?? null);
  const siteEditChoices = siteEditing === null ? [] : siteChoicesFor(sites, siteIdOf(siteEditing));
  // 追加の Modal はアーカイブしたサイトを選ばせない（設計 §9.1.2）。
  const createSiteChoices = canReadSites ? siteChoicesFor(sites, null) : [];

  /** 行の「サイト」列の表示（設計 §9.1.1）。 */
  function siteLabelOf(account: AccountRowWithSite): string {
    const siteId = siteIdOf(account);
    if (siteId === null) return SITE_COMMON_LABEL;
    const site = sites.find((candidate) => candidate.id === siteId);
    return site === undefined ? SITE_UNNAMED_LABEL : siteNameLabel(site);
  }

  // 絞り込み（設計 §9.1.4。裁定 9）。**手元で絞る。** 要求を出さず、URL も変えない。
  // 選択肢は「すべて」「共通」と、アカウントが紐づいているサイト（渡された順＝名前順）。
  const linkedSiteIds = new Set(
    accounts.map(siteIdOf).filter((siteId): siteId is string => siteId !== null),
  );
  const filterSites = sites.filter((site) => linkedSiteIds.has(site.id));
  const showSiteFilter = linkedSiteIds.size > 0;
  // 選んでいたサイトのアカウントが無くなったら「すべて」に戻す（空の一覧にしない）。
  const activeFilter =
    siteFilter === SITE_FILTER_COMMON_VALUE || filterSites.some((site) => site.id === siteFilter)
      ? siteFilter
      : SITE_FILTER_ALL_VALUE;
  const shownAccounts =
    !showSiteFilter || activeFilter === SITE_FILTER_ALL_VALUE
      ? accounts
      : accounts.filter((account) =>
          activeFilter === SITE_FILTER_COMMON_VALUE
            ? siteIdOf(account) === null
            : siteIdOf(account) === activeFilter,
        );

  /** **入力値を持ち越さない。** 閉じたら捨てる（設計 §7.5）。 */
  function closeCreate(): void {
    setCreating(false);
    setCredential('');
    setCredentialValues({});
    setCreateSiteId(SITE_COMMON_VALUE);
    setFormError(null);
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    // 入力の形ごとの本文（039 設計 §7.2）。**`credential` と `credentials` の両方は送れない**
    // （API が 422 にする。035 設計 §6.4）。資格情報を使わない provider には何も送らない。
    // 入力の形の判断は `buildCreateAccountRequest` が `providers` から行う（039 設計 §7.7.1）。
    // 平文はここでだけ扱う。応答には含まれない。
    const result = await apiRequest<AccountRowWithSite>('/api/v1/social/accounts', {
      method: 'POST',
      body: buildCreateAccountRequest(props.providers, {
        provider: String(form.get('provider') ?? provider),
        displayName: String(form.get('displayName') ?? ''),
        handle: String(form.get('handle') ?? ''),
        values: credentialValues,
        credential,
        // 共通なら null（053 設計 §9.1.2）。`site.read` が無ければ常に共通。
        siteId: canReadSites && createSiteId !== SITE_COMMON_VALUE ? createSiteId : null,
      }),
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

  function openEdit(account: AccountRowWithSite): void {
    setEditValues({});
    setEditCredential('');
    setEditError(null);
    setClearing(false);
    setEditingId(account.id);
  }

  /** **入力値を持ち越さない。** 閉じたら捨てる（039 設計 §7.3.3）。 */
  function closeEdit(): void {
    setEditingId(null);
    setEditValues({});
    setEditCredential('');
    setEditError(null);
    setClearing(false);
  }

  /**
   * 応答のうち `credentialConfigured` と `status` だけを行に重ねる。
   * **応答をそのまま行にしない**（行が持つのは `AccountRow` のキーと `siteId` だけ。039 設計 #24）。
   */
  function applyUpdate(id: string, updated: AccountRowWithSite): void {
    setAccounts((current) =>
      current.map((account) =>
        account.id === id
          ? {
              ...account,
              credentialConfigured: updated.credentialConfigured,
              status: updated.status,
            }
          : account,
      ),
    );
  }

  function openSiteEdit(account: AccountRowWithSite): void {
    setSiteEditValue(initialSiteChoice(sites, account));
    setSiteEditError(null);
    setSiteEditingId(account.id);
  }

  function closeSiteEdit(): void {
    setSiteEditingId(null);
    setSiteEditError(null);
  }

  /** 「サイトの紐づけを変える」の保存（設計 §9.1.3）。失敗したら Modal は開いたまま。 */
  async function submitSiteEdit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const target = siteEditing;
    if (target === null) return;
    setSiteEditError(null);

    const result = await apiRequest<AccountRowWithSite>(`/api/v1/social/accounts/${target.id}`, {
      method: 'PATCH',
      body: { siteId: siteEditValue === SITE_COMMON_VALUE ? null : siteEditValue },
    });

    if (!result.ok) {
      setSiteEditError(result.error.message);
      return;
    }

    // 応答のうち `siteId` だけを行に重ねる（応答をそのまま行にしない）。
    const siteId = result.data.siteId ?? null;
    setAccounts((current) =>
      current.map((account) => (account.id === target.id ? { ...account, siteId } : account)),
    );
    closeSiteEdit();
    setToast({ id: `${target.id}:site`, text: SITE_CHANGED, tone: 'success' });
  }

  async function submitEdit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const target = editing;
    if (target === null) return;
    setEditError(null);

    // 画面での確かめは UX のため。正はサーバ（`06` §33）。
    const built = buildSetCredentialRequest(props.providers, target, editValues, editCredential);
    if (!built.ok) {
      setEditError(built.message);
      return;
    }

    const result = await apiRequest<AccountRowWithSite>(`/api/v1/social/accounts/${target.id}`, {
      method: 'PATCH',
      body: built.body,
    });

    if (!result.ok) {
      // 入力値は残す（直して送り直せる）。一覧は変えない。
      setEditError(result.error.message);
      return;
    }

    applyUpdate(target.id, result.data);
    closeEdit();
    setToast({ id: `${target.id}:credential`, text: CREDENTIAL_SAVED, tone: 'success' });
    // 投稿一覧の「資格情報 未設定」は Server Component が渡す値で描かれる（039 設計 §7.3.4）。
    router.refresh();
  }

  async function confirmClear(): Promise<void> {
    const target = editing;
    setClearing(false);
    if (target === null) return;

    const result = await apiRequest<AccountRowWithSite>(`/api/v1/social/accounts/${target.id}`, {
      method: 'PATCH',
      body: buildClearCredentialRequest(props.providers, target),
    });

    if (!result.ok) {
      // Modal は開いたまま（039 設計 §7.4 の 4）。
      setToast({ id: `${target.id}:credential`, text: result.error.message, tone: 'danger' });
      return;
    }

    applyUpdate(target.id, result.data);
    closeEdit();
    setToast({ id: `${target.id}:credential`, text: CREDENTIAL_CLEARED, tone: 'success' });
    router.refresh();
  }

  const columns: Column<AccountRowWithSite>[] = [
    {
      key: 'provider',
      header: 'サービス',
      width: '10rem',
      // publisher の表示名を優先する（設計 §5.6.1）。部品に自前の対応表を持たない。
      // provider は HTTP で決められるので、自分のプロパティだけを見る（047 設計 §4.1）。
      render: (account) => ownValue(providerLabels, account.provider) ?? account.provider,
    },
    { key: 'displayName', header: '表示名', render: (account) => account.displayName },
    { key: 'handle', header: 'ハンドル', render: (account) => account.handle },
    {
      key: 'site',
      header: SITE_COLUMN_HEADER,
      width: '9rem',
      // 閲覧者にも見せる（053 設計 §9.1.1）。名前を引けなければ「サイト専用」。
      render: (account) => siteLabelOf(account),
    },
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
      // 3 つのボタンが収まる幅（039 設計 §7.3.1、053 設計 §9.1.3）。狭い画面では表の中で横に動く。
      width: '20rem',
      render: (account) =>
        canWrite || canDelete ? (
          <div style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
            {canWrite && (
              <Button variant="ghost" onClick={() => openEdit(account)}>
                {CREDENTIAL_SET_LABEL}
              </Button>
            )}
            {/* サイトの一覧を見られなければ選びようがないので出さない（053 設計 §9.1.3）。 */}
            {canWrite && canReadSites && (
              <Button variant="ghost" onClick={() => openSiteEdit(account)}>
                {SITE_CHANGE_LABEL}
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" onClick={() => setDeleting(account)}>
                削除
              </Button>
            )}
          </div>
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
        {showSiteFilter && (
          <FormField label={SITE_FILTER_LABEL}>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={activeFilter}
                onChange={(event) => setSiteFilter(event.target.value)}
              >
                <option value={SITE_FILTER_ALL_VALUE}>{SITE_FILTER_ALL}</option>
                <option value={SITE_FILTER_COMMON_VALUE}>{SITE_COMMON_LABEL}</option>
                {filterSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {siteNameLabel(site)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        )}
        <Card>
          <Table columns={columns} rows={shownAccounts} rowKey={(account) => account.id} />
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

          {/* 選んだ provider に追従する（state は provider だけ。手順書は選択肢から引く）。 */}
          {createHelp !== undefined && (
            <div style={{ margin: '0 0 var(--tf-space-4)' }}>
              <HelpLink href={createHelp.href} title={createHelp.title} />
            </div>
          )}

          {/* 「表示名」の上（053 設計 §9.1.2）。`site.read` が無ければ「共通」だけで選ばせない。 */}
          <FormField
            label={SITE_COLUMN_HEADER}
            description={canReadSites ? SITE_SELECT_DESCRIPTION : SITE_SELECT_NO_PERMISSION}
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                name="siteId"
                value={canReadSites ? createSiteId : SITE_COMMON_VALUE}
                disabled={!canReadSites}
                onChange={(event) => setCreateSiteId(event.target.value)}
              >
                <option value={SITE_COMMON_VALUE}>{SITE_COMMON_OPTION}</option>
                {createSiteChoices.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
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
            入力の形ごとに出し分ける（039 設計 §7.2）。項目の宣言があれば項目ごとの欄、
            資格情報を使わないと宣言した publisher なら欄を出さず、publisher が無ければ
            従来どおり 1 つの欄。**保存後は再表示しない**（`06` §38）。
          */}
          {createInput === 'fields' && (
            <CredentialFields
              fields={credentialFields}
              values={credentialValues}
              onChange={(key, value) =>
                setCredentialValues((current) => ({ ...current, [key]: value }))
              }
            />
          )}
          {createInput === 'none' && (
            <p
              style={{
                margin: '0 0 var(--tf-space-4)',
                color: 'var(--tf-color-text-muted)',
                fontSize: '0.875rem',
              }}
            >
              {CREDENTIAL_NONE_NOTE}
            </p>
          )}
          {createInput === 'free' && (
            <SecretField
              label={CREDENTIAL_GENERIC_FIELD_LABEL}
              configured={false}
              onChange={setCredential}
              placeholder="保存後は再表示されません"
            />
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

      <Modal open={editing !== null} title={CREDENTIAL_SET_LABEL} onClose={closeEdit}>
        {editing !== null && (
          <form onSubmit={submitEdit}>
            <p style={{ margin: '0 0 var(--tf-space-1)' }}>
              {credentialTargetLabel(
                editing.displayName,
                ownValue(providerLabels, editing.provider) ?? editing.provider,
              )}
            </p>
            <p style={{ margin: '0 0 var(--tf-space-4)' }}>
              {editing.credentialConfigured
                ? CREDENTIAL_STATE_CONFIGURED
                : CREDENTIAL_STATE_NOT_CONFIGURED}
            </p>

            {editHelp !== undefined && (
              <div style={{ margin: '0 0 var(--tf-space-4)' }}>
                <HelpLink href={editHelp.href} title={editHelp.title} />
              </div>
            )}

            {editError !== null && (
              <div style={{ marginBottom: 'var(--tf-space-4)' }}>
                <Alert tone="danger">{editError}</Alert>
              </div>
            )}

            <div style={{ marginBottom: 'var(--tf-space-4)' }}>
              <Alert tone="info">
                {editInput === 'fields'
                  ? CREDENTIAL_FIELDS_NOTE
                  : editInput === 'free'
                    ? CREDENTIAL_FREE_NOTE
                    : CREDENTIAL_NONE_NOTE}
              </Alert>
            </div>

            {editInput === 'none' && editing.credentialConfigured && (
              <div style={{ marginBottom: 'var(--tf-space-4)' }}>
                <Alert tone="warning">
                  {CREDENTIAL_NONE_WARNING.map((line) => (
                    <span key={line} style={{ display: 'block' }}>
                      {line}
                    </span>
                  ))}
                </Alert>
              </div>
            )}

            {editInput === 'fields' && (
              <CredentialFields
                fields={editFields}
                values={editValues}
                onChange={(key, value) =>
                  setEditValues((current) => ({ ...current, [key]: value }))
                }
              />
            )}
            {editInput === 'free' && (
              <SecretField
                label={CREDENTIAL_GENERIC_FIELD_LABEL}
                configured={false}
                onChange={setEditCredential}
                placeholder="保存後は再表示されません"
              />
            )}

            <div style={{ display: 'flex', gap: 'var(--tf-space-2)', flexWrap: 'wrap' }}>
              {editing.credentialConfigured && (
                <Button variant="danger" onClick={() => setClearing(true)}>
                  {CREDENTIAL_CLEAR_LABEL}
                </Button>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--tf-space-2)',
                  justifyContent: 'flex-end',
                  marginLeft: 'auto',
                }}
              >
                {editInput === 'none' ? (
                  <Button variant="secondary" onClick={closeEdit}>
                    閉じる
                  </Button>
                ) : (
                  <>
                    <Button variant="secondary" onClick={closeEdit}>
                      キャンセル
                    </Button>
                    <Button type="submit" variant="primary">
                      保存
                    </Button>
                  </>
                )}
              </div>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={siteEditing !== null} title={SITE_CHANGE_TITLE} onClose={closeSiteEdit}>
        {siteEditing !== null && (
          <form onSubmit={submitSiteEdit}>
            {siteEditError !== null && (
              <div style={{ marginBottom: 'var(--tf-space-4)' }}>
                <Alert tone="danger">{siteEditError}</Alert>
              </div>
            )}

            <FormField label={SITE_COLUMN_HEADER}>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={siteEditValue}
                  onChange={(event) => setSiteEditValue(event.target.value)}
                >
                  <option value={SITE_COMMON_VALUE}>{SITE_COMMON_OPTION}</option>
                  {siteEditChoices.map((site) => (
                    <option key={site.id} value={site.id}>
                      {siteNameLabel(site)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <div style={{ marginBottom: 'var(--tf-space-4)' }}>
              <Alert tone="warning">{SITE_CHANGE_WARNING}</Alert>
            </div>

            <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={closeSiteEdit}>
                キャンセル
              </Button>
              <Button type="submit" variant="primary">
                保存
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* 入れ直しの Modal の上に重ねる。失敗したら Modal は開いたまま（039 設計 §7.4）。 */}
      <ConfirmDialog
        open={clearing && editing !== null}
        title={CREDENTIAL_CLEAR_CONFIRM_TITLE}
        message={editing === null ? '' : credentialClearMessage(editing.displayName)}
        confirmLabel={CREDENTIAL_CLEAR_CONFIRM_LABEL}
        onConfirm={confirmClear}
        onCancel={() => setClearing(false)}
      />

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
