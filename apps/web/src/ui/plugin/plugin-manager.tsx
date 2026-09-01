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
  Toast,
  type ToastMessage,
} from '@/ui/components';
import { EmptyState } from '@/ui/components';

/**
 * Plugin 管理画面（012-plugin-manager 設計 §10）。
 *
 * **再ビルドと再起動を伴うことを、押す前に伝える。**
 * 押したあとに落ちると障害に見える。
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

export interface PluginManagerProps {
  readonly installed: readonly PluginRow[];
  readonly detected: readonly PluginRow[];
  readonly problems: readonly { pluginId: string; message: string }[];
  readonly operations: readonly OperationRow[];
  readonly canSelfRestart: boolean;
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
  readonly permissions: readonly string[];
  /** zip から入れる場合のファイル。配置済みのものを入れるときは null。 */
  readonly file: File | null;
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
      file: null,
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
    setPending({ ...result.data, file });
  }

  async function confirmInstall(): Promise<void> {
    const target = pending;
    if (target === null) return;
    setBusy(true);

    const result =
      target.file === null
        ? await apiRequest<{ operationId: string; willRestart: boolean; message: string }>(
            '/api/v1/plugins',
            { method: 'POST', body: { pluginId: target.pluginId, acknowledgedPermissions: true } },
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

      {!props.canSelfRestart && (
        <Alert tone="info">
          この環境は自動で再起動しません。Plugin を導入・削除したあとは
          <code> pnpm dev </code>
          を再起動してください。
        </Alert>
      )}

      <section aria-labelledby="installed-heading">
        <h2 id="installed-heading" style={{ fontSize: '1rem' }}>
          インストール済み
        </h2>
        {installed.length === 0 ? (
          <EmptyState message="「Pluginを追加」から Plugin Package を選ぶか、plugins/ へ置いてください。" />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
            {installed.map((plugin) => (
              <Card key={plugin.id} title={`${plugin.name}  ${plugin.version}`}>
                <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
                  {STATUS_LABEL[plugin.status ?? ''] ?? plugin.status}
                  {plugin.status === 'enabled' && !plugin.loaded ? '（再起動待ち）' : ''}
                </p>
                <PermissionList permissions={plugin.permissions} />
                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--tf-space-2)',
                    marginTop: 'var(--tf-space-3)',
                  }}
                >
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
            ))}
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
                <PermissionList permissions={plugin.permissions} />
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

      {pending !== null && (
        <Modal
          open
          title={`${pending.name} ${pending.version} を導入します`}
          onClose={() => setPending(null)}
        >
          <p style={{ marginTop: 0 }}>この Plugin は次の権限を要求しています。</p>
          <PermissionList
            permissions={pending.permissions}
            emptyText="要求している権限はありません。"
          />
          <Alert tone="warning">
            {props.canSelfRestart
              ? '導入すると、とりふねは再ビルドと再起動を行います。その間、数分ほど利用できません。'
              : '導入したあと、手動で再起動する必要があります。'}
          </Alert>
          <div style={{ display: 'flex', gap: 'var(--tf-space-2)', justifyContent: 'flex-end' }}>
            <Button onClick={() => setPending(null)}>キャンセル</Button>
            <Button variant="primary" disabled={busy} onClick={() => void confirmInstall()}>
              同意して導入
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
