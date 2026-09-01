'use client';

import { useState } from 'react';
import { SESSION_IDLE_TIMEOUT_MS, SESSION_LIFETIME_MS } from '@/domain/session';
import { REMEMBER_ME_LIFETIME_MS, type SystemSettings } from '@/domain/system-settings';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Card, Checkbox, Toast, type ToastMessage } from '@/ui/components';

/**
 * 設定 → 認証（06_画面設計.md §16、04_認証設計.md §11）。
 *
 * **セッションの期間は表示のみ。** 画面から変えられるようにすると、
 * 短くしすぎて自分を締め出す、長くしすぎて放置端末が生きる、といった
 * 事故が起きる（015b-settings 設計 §3.1）。
 */

function days(ms: number): string {
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}日`;
}

function hours(ms: number): string {
  return `${Math.round(ms / (60 * 60 * 1000))}時間`;
}

export function AuthSettings({
  settings,
  canManage,
  authProviderId,
}: {
  readonly settings: SystemSettings;
  readonly canManage: boolean;
  /** いま有効な認証方式。Plugin が差し替えている場合はその Plugin の ID。 */
  readonly authProviderId: string;
}) {
  const [rememberMeEnabled, setRememberMeEnabled] = useState(settings.rememberMeEnabled);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle(next: boolean): Promise<void> {
    setError(null);
    setBusy(true);

    const result = await apiRequest('/api/v1/settings', {
      method: 'PUT',
      body: { rememberMeEnabled: next },
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setRememberMeEnabled(next);
    setToast({ id: crypto.randomUUID(), tone: 'success', text: '保存しました。' });
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>認証方式</h2>
        <p style={{ margin: 0 }}>
          いま有効な認証方式：<code>{authProviderId}</code>
        </p>
        <p style={{ color: 'var(--tf-color-text-muted)' }}>
          外部の認証方式はプラグインとして導入します（
          <a href="/plugins">プラグイン管理</a>）。 差し替えは監査ログに残ります。
        </p>
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>セッション</h2>

        {/* 表示のみ。変えられないことを明記する。 */}
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--tf-space-2)' }}>
          <dt>有効期限</dt>
          <dd style={{ margin: 0 }}>{days(SESSION_LIFETIME_MS)}</dd>
          <dt>無操作で切れるまで</dt>
          <dd style={{ margin: 0 }}>{hours(SESSION_IDLE_TIMEOUT_MS)}</dd>
          <dt>長期ログインの期間</dt>
          <dd style={{ margin: 0 }}>{days(REMEMBER_ME_LIFETIME_MS)}</dd>
        </dl>

        <p style={{ color: 'var(--tf-color-text-muted)' }}>
          これらの値は画面からは変更できません。
        </p>
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>長期ログイン</h2>

        {!canManage && (
          <Alert tone="info">
            この設定を変更するには「システム管理」の権限が必要です。表示のみできます。
          </Alert>
        )}

        {error !== null && <Alert tone="danger">{error}</Alert>}

        <Checkbox
          label="ログイン画面で「ログインしたままにする」を選べるようにする"
          checked={rememberMeEnabled}
          disabled={!canManage || busy}
          onChange={(event) => void toggle(event.target.checked)}
        />

        <p style={{ color: 'var(--tf-color-text-muted)' }}>
          長期ログインのセッションは{days(REMEMBER_ME_LIFETIME_MS)}
          有効です。盗まれたときに使える期間が長くなるため、
          共用端末を使う運用では無効にしてください。
        </p>

        {!rememberMeEnabled && (
          <Alert tone="info">
            無効にしても、すでに発行済みの長期セッションは期限まで有効です。
            すぐに切りたい場合は、対象のユーザーのパスワードを変更してください。
          </Alert>
        )}
      </Card>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
