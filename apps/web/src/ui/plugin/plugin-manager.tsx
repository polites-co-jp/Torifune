'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describePermission, isHighPrivilegePermission } from '@/domain/permission';
import { apiRequest, apiUpload } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  FormField,
  Input,
  Modal,
  Spinner,
  Tabs,
  Toast,
  type ToastMessage,
} from '@/ui/components';
import { EmptyState } from '@/ui/components';

/**
 * Plugin 管理画面（012-plugin-manager 設計 §10、020-plugin-registry 設計 §2.7）。
 *
 * **再ビルドと再起動を伴うことを、押す前に伝える。**
 * 押したあとに落ちると障害に見える。
 *
 * タブは「インストール済み」と「Registry」の2つ（06_画面設計.md §18）。
 * **Registry からの導入だけが署名検証を通る**（020-plugin-registry 設計 §2.2）。
 * 扱いの違いを画面で明示する。
 */

export interface PluginRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly status: string | null;
  readonly loaded: boolean;
  readonly permissions: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly description: string | null;
  /** Manifest の任意項目。宣言が無ければ null。 */
  readonly author: string | null;
}

export interface OperationRow {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: string;
  readonly status: string;
  readonly message: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** Registry の1件（03_プラグイン設計.md §15）。API から JSON で受け取る形。 */
export interface RegistryEntryRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly publisher: string | null;
  readonly apiVersion: number | null;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly torifuneVersion: string | null;
  readonly updatedAt: string | null;
  /** 宣言が無ければ null。「要求しない」と区別する。 */
  readonly permissions: readonly string[] | null;
}

export interface DependencyGapRow {
  readonly dependsOn: string;
  readonly required: string;
  readonly reason: 'missing' | 'disabled' | 'version_mismatch';
  readonly actual: string | null;
}

export interface RegistryCompatibilityRow {
  readonly apiVersion: 'ok' | 'unsupported' | 'unknown';
  readonly torifuneVersion: 'ok' | 'unsupported' | 'unknown';
  readonly dependencies: readonly DependencyGapRow[];
  readonly installedVersion: string | null;
  readonly updateAvailable: boolean;
  readonly installable: boolean;
}

export interface RegistryItemRow {
  readonly entry: RegistryEntryRow;
  readonly compatibility: RegistryCompatibilityRow;
}

interface RegistryListResponse {
  readonly configured: boolean;
  readonly trusted: boolean;
  readonly items: readonly RegistryItemRow[];
  readonly error: string | null;
}

export type PluginManagerTab = 'installed' | 'registry';

export interface PluginManagerProps {
  readonly installed: readonly PluginRow[];
  readonly detected: readonly PluginRow[];
  readonly problems: readonly { pluginId: string; message: string }[];
  readonly operations: readonly OperationRow[];
  readonly canSelfRestart: boolean;
  /** 表示するタブ。選択状態は URL に持つ（06_画面設計.md §32）。 */
  readonly tab?: PluginManagerTab;
}

const STATUS_LABEL: Record<string, string> = {
  installed: '導入済み（無効）',
  enabled: '有効',
  disabled: '無効',
};

interface PendingInstall {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  /** Registry が宣言していない場合は null。「要求しない」と区別する。 */
  readonly permissions: readonly string[] | null;
  /** どこから入れるか。**署名検証の有無が変わる**（020-plugin-registry 設計 §2.2）。 */
  readonly source: 'local' | 'registry';
  /** zip から入れる場合のファイル。配置済み・Registry のときは null。 */
  readonly file: File | null;
  /** Registry から入れるとき、満たしていない依存。導入はできるが有効化できない。 */
  readonly dependencyGaps: readonly DependencyGapRow[];
  /** いま入っている版。更新のときだけ入る。文言と確認の内容が変わる。 */
  readonly currentVersion: string | null;
}

export function PluginManager(props: PluginManagerProps) {
  const [installed, setInstalled] = useState(props.installed);
  const [detected, setDetected] = useState(props.detected);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [deleting, setDeleting] = useState<PluginRow | null>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Registry の一覧。
   *
   * **タブに関係なく一度だけ取る。** インストール済みの一覧にも
   * 「新しい版があります」を出す必要があり（03_プラグイン設計.md §13）、
   * タブごとに取ると同じ配布元を二度叩くことになる。
   */
  const [registry, setRegistry] = useState<RegistryListResponse | null>(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryFailure, setRegistryFailure] = useState<string | null>(null);

  const loadRegistry = useCallback(async (searchFor: string): Promise<void> => {
    setRegistryLoading(true);
    const trimmed = searchFor.trim();
    const result = await apiRequest<RegistryListResponse>(
      `/api/v1/plugins/registry${trimmed === '' ? '' : `?q=${encodeURIComponent(trimmed)}`}`,
    );
    setRegistryLoading(false);

    if (!result.ok) {
      setRegistryFailure(result.error.message);
      setRegistry(null);
      return;
    }
    setRegistryFailure(null);
    setRegistry(result.data);
  }, []);

  useEffect(() => {
    void loadRegistry('');
  }, [loadRegistry]);

  /** 導入済み Plugin に対する、Registry 上の新しい版。無ければ undefined。 */
  function updateFor(pluginId: string): RegistryItemRow | undefined {
    return registry?.items.find(
      (item) => item.entry.id === pluginId && item.compatibility.updateAvailable,
    );
  }

  function notify(text: string, tone: ToastMessage['tone']): void {
    setToast({ id: `${Date.now()}`, text, tone });
  }

  async function toggle(plugin: PluginRow, action: 'enable' | 'disable'): Promise<void> {
    setBusy(true);
    const result = await apiRequest<{ ok?: boolean; reason?: string; disabled?: string[] }>(
      `/api/v1/plugins/${plugin.id}/${action}`,
      { method: 'POST', body: {} },
    );
    setBusy(false);

    if (!result.ok) {
      notify(result.error.message, 'danger');
      return;
    }

    if (action === 'enable' && result.data?.ok === false) {
      // 依存を満たしていないなど。理由を隠さない。
      notify(result.data.reason ?? '有効化できませんでした。', 'danger');
      return;
    }

    // 依存元も一緒に止まる。何が止まったかを伝える。
    const alsoDisabled = (result.data?.disabled ?? []).filter((id) => id !== plugin.id);
    const nextStatus = action === 'enable' ? 'enabled' : 'disabled';

    setInstalled((current) =>
      current.map((row) =>
        row.id === plugin.id || alsoDisabled.includes(row.id)
          ? { ...row, status: row.id === plugin.id ? nextStatus : 'disabled', loaded: false }
          : row,
      ),
    );

    notify(
      alsoDisabled.length === 0
        ? action === 'enable'
          ? '有効にしました。'
          : '無効にしました。'
        : `無効にしました。依存していた ${alsoDisabled.join(', ')} も無効になりました。`,
      'success',
    );
  }

  async function installDetected(plugin: PluginRow): Promise<void> {
    setPending({
      pluginId: plugin.id,
      name: plugin.name,
      version: plugin.version,
      permissions: plugin.permissions,
      source: 'local',
      file: null,
      dependencyGaps: [],
      currentVersion: null,
    });
  }

  /**
   * Registry から入れる（新規導入・更新のどちらも同じ経路）。
   * **押す前に、要求 Permission と互換性を見せる。**
   */
  function installFromRegistry(item: RegistryItemRow): void {
    setPending({
      pluginId: item.entry.id,
      name: item.entry.name,
      version: item.entry.version,
      permissions: item.entry.permissions,
      source: 'registry',
      file: null,
      dependencyGaps: item.compatibility.dependencies,
      currentVersion: item.compatibility.installedVersion,
    });
  }

  async function chooseFile(file: File): Promise<void> {
    setBusy(true);
    const form = new FormData();
    form.append('file', file);

    const result = await apiUpload<{
      pluginId: string;
      name: string;
      version: string;
      permissions: string[];
    }>('/api/v1/plugins/package/inspect', form);
    setBusy(false);

    if (!result.ok) {
      const detail = Object.values(result.error.details ?? {})
        .flat()
        .join(' ');
      notify(detail === '' ? result.error.message : detail, 'danger');
      return;
    }

    // **導入する前に要求 Permission を見せる**（06_画面設計.md §39）。
    setPending({
      ...result.data,
      source: 'local',
      file,
      dependencyGaps: [],
      currentVersion: installed.find((row) => row.id === result.data.pluginId)?.version ?? null,
    });
  }

  async function confirmInstall(): Promise<void> {
    const target = pending;
    if (target === null) return;
    setBusy(true);

    const result =
      target.source === 'registry'
        ? await apiRequest<{ operationId: string; willRestart: boolean; message: string }>(
            '/api/v1/plugins/registry',
            { method: 'POST', body: { pluginId: target.pluginId } },
          )
        : target.file === null
          ? await apiRequest<{ operationId: string; willRestart: boolean; message: string }>(
              '/api/v1/plugins',
              {
                method: 'POST',
                body: { pluginId: target.pluginId, acknowledgedPermissions: true },
              },
            )
          : await (async () => {
              const form = new FormData();
              form.append('file', target.file as File);
              form.append('pluginId', target.pluginId);
              return apiUpload<{ operationId: string; willRestart: boolean; message: string }>(
                '/api/v1/plugins/package/install',
                form,
              );
            })();

    setBusy(false);
    setPending(null);

    if (!result.ok) {
      const detail = Object.values(result.error.details ?? {})
        .flat()
        .join(' ');
      notify(detail === '' ? result.error.message : detail, 'danger');
      return;
    }

    setDetected((current) => current.filter((row) => row.id !== target.pluginId));

    if (result.data.willRestart) {
      setWatching(result.data.operationId);
    } else {
      notify(result.data.message, 'info');
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setBusy(true);

    const result = await apiRequest<{ willRestart: boolean; operationId: string; message: string }>(
      `/api/v1/plugins/${target.id}`,
      {
        method: 'DELETE',
        body: { deleteData, deleteFiles: true, confirm: confirmText },
      },
    );

    setBusy(false);
    setDeleting(null);
    setConfirmText('');
    setDeleteData(false);

    if (!result.ok) {
      const detail = Object.values(result.error.details ?? {})
        .flat()
        .join(' ');
      notify(detail === '' ? result.error.message : detail, 'danger');
      return;
    }

    setInstalled((current) => current.filter((row) => row.id !== target.id));

    if (result.data.willRestart) {
      setWatching(result.data.operationId);
    } else {
      notify(result.data.message, 'success');
    }
  }

  if (watching !== null) {
    return <RebuildProgress operationId={watching} canSelfRestart={props.canSelfRestart} />;
  }

  const tab: PluginManagerTab = props.tab ?? 'installed';

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Plugin管理</h1>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) {
                void chooseFile(file);
              }
            }}
          />
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            Pluginを追加
          </Button>
        </div>
      </div>

      <Tabs
        label="Plugin管理"
        current={tab}
        items={[
          { key: 'installed', label: 'インストール済み' },
          { key: 'registry', label: 'Registry' },
        ]}
        hrefFor={(key) => (key === 'registry' ? '/plugins?tab=registry' : '/plugins')}
      />

      {!props.canSelfRestart && (
        <Alert tone="info">
          この環境は自動で再起動しません。Plugin を導入・削除したあとは
          <code> pnpm dev </code>
          を再起動してください。
        </Alert>
      )}

      {tab === 'registry' && (
        <RegistryPanel
          busy={busy}
          loading={registryLoading}
          failure={registryFailure}
          data={registry}
          onSearch={(keyword) => void loadRegistry(keyword)}
          onInstall={installFromRegistry}
        />
      )}

      {tab === 'installed' && (
        <>
          <section aria-labelledby="installed-heading">
            <h2 id="installed-heading" style={{ fontSize: '1rem' }}>
              インストール済み
            </h2>
            {installed.length === 0 ? (
              <EmptyState message="「Pluginを追加」から Plugin Package を選ぶか、plugins/ へ置いてください。" />
            ) : (
              <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
                {installed.map((plugin) => {
                  const update = updateFor(plugin.id);
                  return (
                    <Card key={plugin.id} title={`${plugin.name}  ${plugin.version}`}>
                      <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
                        {STATUS_LABEL[plugin.status ?? ''] ?? plugin.status}
                        {plugin.status === 'enabled' && !plugin.loaded ? '（再起動待ち）' : ''}
                        {plugin.author !== null && ` ／ 作者: ${plugin.author}`}
                      </p>

                      {/* **新しい版が出ていることに気づけるようにする**（03_プラグイン設計.md §13）。 */}
                      {update !== undefined && (
                        <Alert tone="info">
                          新しい版 {update.entry.version} が Registry にあります（いまは{' '}
                          {plugin.version}）。
                        </Alert>
                      )}

                      <PermissionList permissions={plugin.permissions} />
                      <DependencyList dependencies={plugin.dependencies} />
                      <div
                        style={{
                          display: 'flex',
                          gap: 'var(--tf-space-2)',
                          marginTop: 'var(--tf-space-3)',
                        }}
                      >
                        {update !== undefined && (
                          <Button
                            variant="primary"
                            disabled={
                              busy ||
                              registry?.trusted !== true ||
                              !update.compatibility.installable
                            }
                            onClick={() => installFromRegistry(update)}
                          >
                            更新
                          </Button>
                        )}
                        {plugin.status === 'enabled' ? (
                          <Button disabled={busy} onClick={() => void toggle(plugin, 'disable')}>
                            無効化
                          </Button>
                        ) : (
                          <Button disabled={busy} onClick={() => void toggle(plugin, 'enable')}>
                            有効化
                          </Button>
                        )}
                        {plugin.status === 'enabled' && (
                          <Link href={`/plugins/${plugin.id}`}>
                            <Button>設定</Button>
                          </Link>
                        )}
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            setDeleting(plugin);
                            setConfirmText('');
                            setDeleteData(false);
                          }}
                        >
                          削除
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {detected.length > 0 && (
            <section aria-labelledby="detected-heading">
              <h2 id="detected-heading" style={{ fontSize: '1rem' }}>
                検出済み（plugins/ にあるが未導入）
              </h2>
              <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
                {detected.map((plugin) => (
                  <Card key={plugin.id} title={`${plugin.name}  ${plugin.version}`}>
                    {plugin.author !== null && (
                      <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
                        作者: {plugin.author}
                      </p>
                    )}
                    <PermissionList permissions={plugin.permissions} />
                    <DependencyList dependencies={plugin.dependencies} />
                    <div style={{ marginTop: 'var(--tf-space-3)' }}>
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => void installDetected(plugin)}
                      >
                        導入
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {props.problems.length > 0 && (
            <section aria-labelledby="problems-heading">
              <h2 id="problems-heading" style={{ fontSize: '1rem' }}>
                読み込めなかったPlugin
              </h2>
              {/* 黙って消すと「置いたはずの Plugin が出てこない」理由が分からない。 */}
              {props.problems.map((problem) => (
                <Alert key={problem.pluginId} tone="warning">
                  {problem.pluginId}: {problem.message}
                </Alert>
              ))}
            </section>
          )}
        </>
      )}

      {pending !== null && (
        <Modal
          open
          title={
            pending.currentVersion === null
              ? `${pending.name} ${pending.version} を導入します`
              : `${pending.name} を ${pending.currentVersion} から ${pending.version} へ更新します`
          }
          onClose={() => setPending(null)}
        >
          {pending.currentVersion !== null && (
            /* 更新でデータは消えない（020-plugin-registry 設計 §2.4）。不安にさせない。 */
            <Alert tone="info">更新しても、この Plugin が保存した設定・データは残ります。</Alert>
          )}

          {pending.permissions === null ? (
            /*
              Registry が要求 Permission を宣言していない。
              **「権限を要求していない」と言い切らない。** 確定するのは導入時の Manifest 検証。
            */
            <Alert tone="warning">
              この Registry は要求する権限を宣言していません。実際に要求する権限は、導入時に Plugin
              Package の Manifest で検証されます。配布元を信頼できる場合だけ導入してください。
            </Alert>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>この Plugin は次の権限を要求しています。</p>
              <PermissionList
                permissions={pending.permissions}
                emptyText="要求している権限はありません。"
              />
            </>
          )}

          {/* **経路によって検証の強さが違う**（020-plugin-registry 設計 §2.2）。隠さない。 */}
          <Alert tone="info">
            {pending.source === 'registry'
              ? '配布物の SHA-256 と ed25519 署名を検証してから導入します。検証を通らなければ導入しません。'
              : 'ローカルの Plugin Package は署名を検証しません。自分で用意したものだけを導入してください。'}
          </Alert>

          {pending.dependencyGaps.length > 0 && (
            <Alert tone="warning">
              依存している Plugin が足りません。導入はできますが、 足りない Plugin
              を入れて有効にするまで有効化できません。
              <DependencyGapList gaps={pending.dependencyGaps} />
            </Alert>
          )}

          <Alert tone="warning">
            {props.canSelfRestart
              ? '導入すると、とりふねは再ビルドと再起動を行います。その間、数分ほど利用できません。'
              : '導入したあと、手動で再起動する必要があります。'}
          </Alert>
          <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
            <Button onClick={() => setPending(null)}>キャンセル</Button>
            <Button variant="primary" disabled={busy} onClick={() => void confirmInstall()}>
              {pending.currentVersion === null ? '同意して導入' : '同意して更新'}
            </Button>
          </div>
        </Modal>
      )}

      {deleting !== null && (
        <Modal open title={`${deleting.name} を削除します`} onClose={() => setDeleting(null)}>
          <Checkbox
            label="この Plugin が保存したデータも削除する（設定・保存内容がすべて消えます。元に戻せません）"
            checked={deleteData}
            onChange={(event) => setDeleteData(event.target.checked)}
          />
          <FormField label="削除するには Plugin ID を入力してください">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={confirmText}
                placeholder={deleting.id}
                onChange={(event) => setConfirmText(event.target.value)}
              />
            )}
          </FormField>
          <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
            <Button onClick={() => setDeleting(null)}>キャンセル</Button>
            <Button
              variant="danger"
              disabled={busy || confirmText !== deleting.id}
              onClick={() => void confirmDelete()}
            >
              削除
            </Button>
          </div>
        </Modal>
      )}

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

/**
 * 依存関係（03_プラグイン設計.md §13）。
 *
 * **返しているのに描いていなかった。** 依存先が分からないと、
 * 無効化したときに何が巻き添えになるのかを事前に判断できない。
 */
function DependencyList({
  dependencies,
}: {
  readonly dependencies: Readonly<Record<string, string>>;
}) {
  const entries = Object.entries(dependencies);
  if (entries.length === 0) {
    return null;
  }

  return (
    <p style={{ margin: 'var(--tf-space-2) 0', color: 'var(--tf-color-text-muted)' }}>
      依存:{' '}
      {entries.map(([id, range], index) => (
        <span key={id}>
          {index > 0 ? ', ' : ''}
          <code>
            {id} {range}
          </code>
        </span>
      ))}
    </p>
  );
}

/** 満たしていない依存を、理由つきで並べる（03_プラグイン設計.md §17）。 */
function DependencyGapList({ gaps }: { readonly gaps: readonly DependencyGapRow[] }) {
  return (
    <ul style={{ margin: 'var(--tf-space-2) 0', paddingLeft: '1.25rem' }}>
      {gaps.map((gap) => (
        <li key={gap.dependsOn}>
          <code>
            {gap.dependsOn} {gap.required}
          </code>
          {gap.reason === 'missing' && ' — 導入されていません'}
          {gap.reason === 'disabled' && ' — 導入されていますが無効です'}
          {gap.reason === 'version_mismatch' && ` — 入っているのは ${gap.actual ?? '不明'} です`}
        </li>
      ))}
    </ul>
  );
}

function formatUpdatedAt(value: string | null): string {
  if (value === null) {
    return '不明';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '不明' : parsed.toLocaleString('ja-JP');
}

/**
 * Registry タブ（03_プラグイン設計.md §14.1 §15、06_画面設計.md §18）。
 *
 * **配布元を信じる前に、判断の材料を出す。** 配布元・要求 Permission・
 * Plugin API Version・依存・対応 Torifune Version・更新日時を、
 * **導入を押す前に**並べる。zip を落として展開してからでは遅い。
 */
function RegistryPanel({
  busy,
  loading,
  failure,
  data,
  onSearch,
  onInstall,
}: {
  readonly busy: boolean;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly data: RegistryListResponse | null;
  readonly onSearch: (keyword: string) => void;
  readonly onInstall: (item: RegistryItemRow) => void;
}) {
  const [keyword, setKeyword] = useState('');

  return (
    <section
      aria-labelledby="registry-heading"
      style={{ display: 'grid', gap: 'var(--tf-space-3)' }}
    >
      <h2 id="registry-heading" style={{ fontSize: '1rem', margin: 0 }}>
        Registry
      </h2>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(keyword);
        }}
        style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'flex-end' }}
      >
        <FormField label="Plugin を検索">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={keyword}
              placeholder="名前・ID・説明で絞り込む"
              onChange={(event) => setKeyword(event.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" disabled={loading}>
          検索
        </Button>
      </form>

      {loading && <Spinner />}
      {failure !== null && <Alert tone="danger">{failure}</Alert>}

      {!loading && data !== null && !data.configured && (
        <Alert tone="info">
          Plugin Registry が設定されていません。環境変数
          <code> TORIFUNE_PLUGIN_REGISTRY_URL </code>
          に、Plugin の一覧を返す JSON の URL（https）を設定してください。
        </Alert>
      )}

      {!loading && data !== null && data.configured && data.error !== null && (
        <Alert tone="danger">Registry を取得できませんでした: {data.error}</Alert>
      )}

      {!loading && data !== null && data.configured && !data.trusted && (
        /* 押してから失敗させない。導入できない理由を先に出す（設計 §2.2）。 */
        <Alert tone="warning">
          信頼する検証鍵が設定されていないため、Registry からは導入できません。環境変数
          <code> TORIFUNE_PLUGIN_TRUSTED_KEYS </code>
          に、配布元の ed25519 公開鍵（base64）を設定してください。
        </Alert>
      )}

      {!loading && data !== null && data.configured && data.error === null && (
        <>
          {data.items.length === 0 ? (
            <EmptyState message="この Registry に該当する Plugin はありません。" />
          ) : (
            <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
              {data.items.map((item) => (
                <RegistryCard
                  key={item.entry.id}
                  item={item}
                  disabled={busy || !data.trusted}
                  onInstall={onInstall}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RegistryCard({
  item,
  disabled,
  onInstall,
}: {
  readonly item: RegistryItemRow;
  readonly disabled: boolean;
  readonly onInstall: (item: RegistryItemRow) => void;
}) {
  const { entry, compatibility } = item;

  return (
    <Card title={`${entry.name}  ${entry.version}`}>
      <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
        配布元: {entry.publisher ?? '不明'} ／ Plugin API Version: {entry.apiVersion ?? '不明'} ／
        対応Torifune: {entry.torifuneVersion ?? '不明'} ／ 更新: {formatUpdatedAt(entry.updatedAt)}
      </p>
      {entry.description !== null && (
        <p style={{ margin: 'var(--tf-space-2) 0' }}>{entry.description}</p>
      )}

      {/* 更新できるものを見つけられるようにする（03_プラグイン設計.md §13）。 */}
      {compatibility.updateAvailable && (
        <Alert tone="info">
          新しい版です。いま入っているのは {compatibility.installedVersion} です。
        </Alert>
      )}
      {compatibility.installedVersion !== null && !compatibility.updateAvailable && (
        <p style={{ margin: 'var(--tf-space-2) 0', color: 'var(--tf-color-text-muted)' }}>
          導入済み（{compatibility.installedVersion}）。
        </p>
      )}

      {/* **合わないものを、押す前に伝える**（03_プラグイン設計.md §15 §16）。 */}
      {compatibility.apiVersion === 'unsupported' && (
        <Alert tone="danger">
          Plugin API Version が合いません（この Plugin は {entry.apiVersion} 向け）。 この Torifune
          では動きません。
        </Alert>
      )}
      {compatibility.apiVersion === 'unknown' && (
        <Alert tone="warning">
          Plugin API Version が宣言されていません。導入時に Manifest で検証されます。
        </Alert>
      )}
      {compatibility.torifuneVersion === 'unsupported' && (
        <Alert tone="danger">
          この Plugin が対応する Torifune のバージョン（{entry.torifuneVersion}）に合いません。
        </Alert>
      )}
      {compatibility.dependencies.length > 0 && (
        <Alert tone="warning">
          依存が足りません。導入はできますが、そのままでは有効化できません。
          <DependencyGapList gaps={compatibility.dependencies} />
        </Alert>
      )}

      <DependencyList dependencies={entry.dependencies} />

      {entry.permissions === null ? (
        <p style={{ margin: 'var(--tf-space-2) 0', color: 'var(--tf-color-text-muted)' }}>
          要求する権限は宣言されていません。導入時に Manifest で検証されます。
        </p>
      ) : (
        <PermissionList
          permissions={entry.permissions}
          emptyText="要求している権限はありません。"
        />
      )}

      <div style={{ marginTop: 'var(--tf-space-3)' }}>
        <Button
          variant="primary"
          disabled={
            disabled ||
            !compatibility.installable ||
            // 同じ版・古い版は入れ直せない（設計 §2.4）。押せる形にしない。
            (compatibility.installedVersion !== null && !compatibility.updateAvailable)
          }
          onClick={() => onInstall(item)}
        >
          {compatibility.updateAvailable ? '更新' : '導入'}
        </Button>
      </div>
    </Card>
  );
}

function PermissionList({
  permissions,
  emptyText,
}: {
  readonly permissions: readonly string[];
  readonly emptyText?: string;
}) {
  if (permissions.length === 0) {
    return emptyText === undefined ? null : (
      <p style={{ color: 'var(--tf-color-text-muted)', margin: 0 }}>{emptyText}</p>
    );
  }

  const high = permissions.filter(isHighPrivilegePermission);

  return (
    <>
      {high.length > 0 && (
        <p
          role="alert"
          data-high-privilege="true"
          style={{
            margin: 'var(--tf-space-2) 0',
            padding: 'var(--tf-space-3)',
            border: '1px solid var(--tf-color-warning)',
            borderRadius: 'var(--tf-radius-md)',
            background: 'var(--tf-color-surface)',
          }}
        >
          {/*
            権限コードを並べるだけでは、読む人はどれが危険かを判断できない
            （06_画面設計.md §39）。何を渡すことになるのかを言葉で出す。
          */}
          <strong>強い権限を要求しています。</strong>
          このプラグインは Torifune 全体を操作できる権限を求めています。
          配布元を信頼できる場合だけ導入してください。
        </p>
      )}

      <ul style={{ margin: 'var(--tf-space-2) 0', paddingLeft: '1.25rem' }}>
        {permissions.map((permission) => {
          const description = describePermission(permission);
          return (
            <li key={permission}>
              <code>{permission}</code>
              {description !== null && (
                <span style={{ color: 'var(--tf-color-text-muted)' }}> — {description}</span>
              )}
              {isHighPrivilegePermission(permission) && (
                <strong style={{ color: 'var(--tf-color-warning)' }}>（強い権限）</strong>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 再起動を跨いで進行状況を見せる（設計 §10.3）。 */
function RebuildProgress({
  operationId,
  canSelfRestart,
}: {
  readonly operationId: string;
  readonly canSelfRestart: boolean;
}) {
  const [status, setStatus] = useState<string>('restarting');
  const [message, setMessage] = useState<string | null>(null);
  const [givenUp, setGivenUp] = useState(false);

  const poll = useCallback(async () => {
    const result = await apiRequest<{ status: string; message: string | null }>(
      `/api/v1/plugins/operations/${operationId}`,
    );

    // **通信の失敗は「まだ落ちている」とみなす。**
    // 再ビルド中は応答が返らない。
    if (!result.ok) {
      return false;
    }

    setStatus(result.data.status);
    setMessage(result.data.message);
    return result.data.status === 'succeeded' || result.data.status === 'failed';
  }, [operationId]);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 150; // 2秒間隔で5分。

    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(timer);
        setGivenUp(true);
        return;
      }
      void poll().then((done) => {
        if (done && !cancelled) {
          clearInterval(timer);
        }
      });
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll]);

  const done = status === 'succeeded' || status === 'failed';

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>
        {status === 'succeeded'
          ? '完了しました'
          : status === 'failed'
            ? '失敗しました'
            : '再ビルド中…'}
      </h1>

      <Card title="進行状況">
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          <li>ファイルを配置した</li>
          <li>Manifest を検証した</li>
          <li>
            {status === 'succeeded'
              ? '再ビルドと再起動が終わった'
              : status === 'failed'
                ? '再ビルドに失敗した'
                : canSelfRestart
                  ? '再ビルドしています（数分かかります）'
                  : '再起動を待っています'}
          </li>
        </ul>
      </Card>

      {message !== null && <Alert tone={status === 'failed' ? 'danger' : 'info'}>{message}</Alert>}

      {givenUp && !done && (
        <Alert tone="warning">時間内に終わりませんでした。サーバーの状態を確認してください。</Alert>
      )}

      {(done || givenUp) && (
        <div>
          <Link href="/plugins">
            <Button variant="primary">Plugin管理へ戻る</Button>
          </Link>
        </div>
      )}

      {!done && !givenUp && (
        <p style={{ color: 'var(--tf-color-text-muted)' }} role="status">
          このページは自動で更新されます。
        </p>
      )}
    </div>
  );
}
