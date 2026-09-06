'use client';

import { useState, type FormEvent } from 'react';
import type { AccessLogIpExclusions } from '@/application/analytics/ip-exclusion-use-cases';
import { IP_EXCLUSION_MAX_RULES } from '@/domain/analytics/ip-exclusion';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  FormField,
  Textarea,
  Toast,
  type ToastMessage,
} from '@/ui/components';

/**
 * 設定 → 一般の「アクセスログの除外IP」の区画（033-analytics-ip-exclusion 設計 §10）。
 *
 * **タブは足さない**（06_画面設計.md §16）。「一般」タブの中に置く。
 *
 * **`canManage` を props に持たない。** 表示名や基準タイムゾーンは
 * 「表示は誰でも、変更は `system.manage`」だが、**除外リストは表示自体が漏洩**である
 * （社内の IP 帯・VPN の出口が書かれる）。描くかどうかは `app/settings/page.tsx` が
 * 権限で分ける——これは表示制御であって、認可は UseCase 側が行う。
 *
 * **保存は別の口**（`PUT /api/v1/settings/access-log-ips`）。表示名の口の応答は
 * 未認証でも読んでよい項目へ射影されており、除外リストを返せない（設計 §8）。
 *
 * **画面の再読み込みをしない。** ヘッダの表示に関わらないので、
 * `GeneralSettings` の `location.reload()` は真似しない。
 */

export interface AccessLogIpSettingsProps {
  /** 保存済みのルール（正規表記）。 */
  readonly rules: readonly string[];
  /** いま画面を見ている人のアクセス元 IP。取れなければ `null`。 */
  readonly clientIp: string | null;
}

/** 入力欄の中身を行の配列にする。空行は保存側（Domain）が落とす。 */
function toLines(text: string): string[] {
  return text.split('\n');
}

export function AccessLogIpSettings({ rules, clientIp }: AccessLogIpSettingsProps) {
  const [text, setText] = useState(rules.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);

  // **行そのものの一致で見る。** 帯（CIDR）に含まれるだけなら足せてよい
  // ——「この 1 台だけを外したい」という指定は帯の指定と両立する。
  const alreadyListed = clientIp !== null && toLines(text).some((line) => line.trim() === clientIp);

  function addClientIp(): void {
    if (clientIp === null || alreadyListed) {
      return;
    }
    setText((current) =>
      current.trim() === '' ? clientIp : `${current.replace(/\n+$/, '')}\n${clientIp}`,
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const result = await apiRequest<AccessLogIpExclusions>('/api/v1/settings/access-log-ips', {
      method: 'PUT',
      body: { rules: toLines(text) },
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    // **正規化後の値を入力欄へ戻す。** `203.0.113.10/24` と書いたものが
    // `203.0.113.0/24` として保存されるので、保存された形をそのまま見せる。
    setText(result.data.rules.join('\n'));
    setToast({ id: crypto.randomUUID(), tone: 'success', text: '保存しました。' });
  }

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>アクセスログの除外IP</h2>

      <p style={{ margin: '0 0 var(--tf-space-4)', color: 'var(--tf-color-text-muted)' }}>
        ここに書いた送信元からのアクセスは記録しません。自社やご自身からのアクセスを
        集計から外すために使います。
      </p>

      <p style={{ margin: '0 0 var(--tf-space-4)' }}>
        現在のあなたのアクセス元IP：
        {clientIp === null ? (
          <span>判別できません（リバースプロキシの設定を確認してください）</span>
        ) : (
          <>
            <code>{clientIp}</code>{' '}
            <Button
              type="button"
              variant="secondary"
              disabled={alreadyListed}
              onClick={addClientIp}
            >
              追加
            </Button>
          </>
        )}
      </p>

      {error !== null && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={onSubmit}>
        <FormField
          label="除外するIP（1行に1件）"
          description={`1件のIP（203.0.113.10）のほか、CIDRで帯（198.51.100.0/24、2001:db8::/32）も指定できます。${IP_EXCLUSION_MAX_RULES}件まで。`}
        >
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              value={text}
              rows={8}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" disabled={busy}>
          保存する
        </Button>
      </form>

      {/*
        **できないことを先に断る**（設計 §2 / §11）。アクセスログに IP は保存しておらず、
        訪問者ハッシュのソルトも残らないため、記録済みの分を後から探して消す手段が無い。
      */}
      <p
        style={{
          margin: 'var(--tf-space-4) 0 0',
          fontSize: 'var(--tf-text-caption)',
          color: 'var(--tf-color-text-subtle)',
          lineHeight: 1.6,
        }}
      >
        この設定は今後の記録にだけ効きます。すでに記録したアクセスは消えません（アクセスログに
        IPアドレスを保存していないため、後から探して消すことができません）。保存済みの集計値も
        計算し直しません。
      </p>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </Card>
  );
}
