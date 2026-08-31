'use client';

import { useState } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  FormField,
  Input,
  Modal,
  Pagination,
  Select,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import { AsyncState } from '@/ui/states/async-state';

/**
 * ユーザー一覧（015-settings）。型A。
 *
 * **危険な操作が集まる画面。** 自分自身と最後の管理者への操作は
 * サーバー側（UseCase）が拒否する。ここで隠すのは誤操作を減らすためで、
 * 認可ではない（06_画面設計.md §29）。
 */

export interface UserRow {
  readonly id: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly lastLoginAt: string | null;
}

export interface RoleOption {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: '有効',
  disabled: '無効',
};

function formatDateTime(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

export interface UserListProps {
  readonly initialUsers: readonly UserRow[];
  readonly availableRoles: readonly RoleOption[];
  readonly currentUserId: string;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

interface FormState {
  readonly mode: 'create' | 'edit';
  readonly target: UserRow | null;
}

export function UserList(props: UserListProps) {
  const [users, setUsers] = useState(props.initialUsers);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [roles, setRoles] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  function openCreate(): void {
    setFormError(null);
    setRoles([]);
    setForm({ mode: 'create', target: null });
  }

  function openEdit(user: UserRow): void {
    setFormError(null);
    setRoles(user.roles);
    setForm({ mode: 'edit', target: user });
  }

  function toggleRole(name: string, checked: boolean): void {
    setRoles((current) =>
      checked ? [...new Set([...current, name])] : current.filter((role) => role !== name),
    );
  }

  async function reload(): Promise<void> {
    const result = await apiRequest<UserRow[]>(
      `/api/v1/users?page=${props.page}&perPage=${props.perPage}`,
    );
    if (result.ok) {
      setUsers(result.data);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (form === null) return;
    setFormError(null);
    setBusy(true);

    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');

    const result =
      form.mode === 'create'
        ? await apiRequest('/api/v1/users', {
            method: 'POST',
            body: {
              loginId: String(data.get('loginId') ?? ''),
              displayName: String(data.get('displayName') ?? ''),
              email: String(data.get('email') ?? ''),
              password,
              roles,
            },
          })
        : await apiRequest(`/api/v1/users/${form.target?.id ?? ''}`, {
            method: 'PATCH',
            body: {
              displayName: String(data.get('displayName') ?? ''),
              email: String(data.get('email') ?? ''),
              status: String(data.get('status') ?? 'active'),
              // 空なら変えない。UseCase 側も同じ扱い。
              ...(password === '' ? {} : { password }),
              roles,
            },
          });

    setBusy(false);

    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }

    setForm(null);
    await reload();
    setToast({
      id: 'saved',
      text: form.mode === 'create' ? '作成しました。' : '保存しました。',
      tone: 'success',
    });
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setDeleting(null);

    const result = await apiRequest(`/api/v1/users/${target.id}`, { method: 'DELETE', body: {} });

    if (result.ok) {
      setUsers((current) => current.filter((user) => user.id !== target.id));
      setToast({ id: target.id, text: '削除しました。', tone: 'success' });
    } else {
      setToast({ id: target.id, text: result.error.message, tone: 'danger' });
    }
  }

  const columns: Column<UserRow>[] = [
    { key: 'loginId', header: 'ログインID', render: (user) => user.loginId, width: '12rem' },
    { key: 'displayName', header: '表示名', render: (user) => user.displayName },
    { key: 'email', header: 'メール', render: (user) => user.email },
    {
      key: 'roles',
      header: 'ロール',
      width: '12rem',
      render: (user) => (user.roles.length === 0 ? '—' : user.roles.join(', ')),
    },
    {
      key: 'status',
      header: '状態',
      width: '6rem',
      render: (user) => STATUS_LABEL[user.status] ?? user.status,
    },
    {
      key: 'lastLoginAt',
      header: '最終ログイン',
      width: '12rem',
      render: (user) => formatDateTime(user.lastLoginAt),
    },
    {
      key: 'actions',
      header: '操作',
      width: '10rem',
      render: (user) => (
        <span style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
          <Button variant="ghost" onClick={() => openEdit(user)}>
            編集
          </Button>
          {/* 自分自身は消せない。**サーバー側でも拒否する。** */}
          {user.id !== props.currentUserId && (
            <Button variant="ghost" onClick={() => setDeleting(user)}>
              削除
            </Button>
          )}
        </span>
      ),
    },
  ];

  const editing = form?.mode === 'edit' ? form.target : null;

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
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>ユーザー</h2>
        <Button variant="primary" onClick={openCreate}>
          + ユーザーを追加
        </Button>
      </header>

      <AsyncState
        status={users.length === 0 ? 'empty' : 'ready'}
        emptyMessage="ユーザーがいません。"
      >
        <Card>
          <Table columns={columns} rows={users} rowKey={(user) => user.id} />
          <Pagination
            page={props.page}
            perPage={props.perPage}
            total={props.total}
            onChange={(page) => {
              window.location.assign(`/settings?tab=users&page=${page}`);
            }}
          />
        </Card>
      </AsyncState>

      <Modal
        open={form !== null}
        title={form?.mode === 'create' ? 'ユーザーを追加' : 'ユーザーを編集'}
        onClose={() => setForm(null)}
      >
        {formError !== null && (
          <div style={{ marginBottom: 'var(--tf-space-4)' }}>
            <Alert tone="danger">{formError}</Alert>
          </div>
        )}
        <form onSubmit={submit}>
          {form?.mode === 'create' && (
            <FormField label="ログインID" required>
              {(fieldProps) => <Input {...fieldProps} name="loginId" required />}
            </FormField>
          )}

          <FormField label="表示名" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                name="displayName"
                defaultValue={editing?.displayName ?? ''}
                required
              />
            )}
          </FormField>

          <FormField label="メールアドレス" required>
            {(fieldProps) => (
              <Input {...fieldProps} name="email" defaultValue={editing?.email ?? ''} required />
            )}
          </FormField>

          <FormField
            label="パスワード"
            {...(form?.mode === 'edit'
              ? {
                  description:
                    '空欄なら変更しません。変更すると、その利用者は再ログインが要ります。',
                }
              : {})}
            {...(form?.mode === 'create' ? { required: true } : {})}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="password"
                name="password"
                autoComplete="new-password"
                required={form?.mode === 'create'}
              />
            )}
          </FormField>

          {form?.mode === 'edit' && (
            <FormField label="状態">
              {(fieldProps) => (
                <Select {...fieldProps} name="status" defaultValue={editing?.status ?? 'active'}>
                  <option value="active">有効</option>
                  <option value="disabled">無効</option>
                </Select>
              )}
            </FormField>
          )}

          <fieldset style={{ border: 0, padding: 0, margin: '0 0 var(--tf-space-4)' }}>
            <legend style={{ padding: 0, marginBottom: 'var(--tf-space-1)' }}>ロール</legend>
            {props.availableRoles.map((role) => (
              <Checkbox
                key={role.id}
                label={`${role.displayName}（${role.name}）`}
                checked={roles.includes(role.name)}
                onChange={(event) => toggleRole(role.name, event.target.checked)}
              />
            ))}
          </fieldset>

          <div style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
            <Button type="submit" variant="primary" disabled={busy}>
              保存
            </Button>
            <Button variant="secondary" onClick={() => setForm(null)}>
              キャンセル
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="ユーザーを削除しますか？"
        message={
          deleting === null
            ? ''
            : `「${deleting.displayName}」（${deleting.loginId}）を削除します。`
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
