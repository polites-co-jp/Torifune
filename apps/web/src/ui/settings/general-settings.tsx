'use client';

import { useState, type FormEvent } from 'react';
import { SERVICE_NAME_MAX_LENGTH, type SystemSettings } from '@/domain/system-settings';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Card, FormField, Input, Toast, type ToastMessage } from '@/ui/components';

/**
 * 設定 → 一般（06_画面設計.md §16）。
 *
 * 置いているのはサービス表示名だけ。
 * **セッションの有効期限などを画面から変えられるようにしない**
 * （015b-settings 設計 §3.1）。短くしすぎて自分を締め出す事故が起きる。
 */
export function GeneralSettings({
  settings,
  canManage,
}: {
  readonly settings: SystemSettings;
  readonly canManage: boolean;
}) {
  const [serviceName, setServiceName] = useState(settings.serviceName);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const result = await apiRequest('/api/v1/settings', {
      method: 'PUT',
      body: { serviceName },
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setToast({ id: crypto.randomUUID(), tone: 'success', text: '保存しました。' });
    // ヘッダとタイトルはサーバー側で描画しているため、
    // 反映を見せるには読み込み直しが要る。
    window.location.reload();
  }

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>一般</h2>

      {!canManage && (
        <Alert tone="info">
          この設定を変更するには「システム管理」の権限が必要です。表示のみできます。
        </Alert>
      )}

      {error !== null && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={onSubmit}>
        <FormField
          label="サービス表示名"
          description="画面のヘッダとブラウザのタイトルに出ます。本番と検証を見分けるために使います。"
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={serviceName}
              maxLength={SERVICE_NAME_MAX_LENGTH}
              disabled={!canManage}
              onChange={(event) => setServiceName(event.target.value)}
            />
          )}
        </FormField>

        {canManage && (
          <Button type="submit" variant="primary" disabled={busy}>
            保存する
          </Button>
        )}
      </form>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </Card>
  );
}
