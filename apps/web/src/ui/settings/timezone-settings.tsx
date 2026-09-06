'use client';

import { useState } from 'react';
import type {
  TimeZoneChangePreview,
  TimeZoneUpdateResult,
} from '@/application/analytics/timezone-use-cases';
import type { AnalyticsTimeZoneSource } from '@/application/analytics/timezone';
import type { TimeZoneGroup } from '@/domain/analytics/time-zone';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  FormField,
  Select,
  Toast,
  type ToastMessage,
} from '@/ui/components';

/**
 * 設定 → 一般の「基準タイムゾーン」の区画（032-timezone-setting 設計 §7.1 / §7.2）。
 *
 * **タブは足さない**（06_画面設計.md §16）。「一般」タブの中に置く。
 *
 * **保存は表示名とは別の口**（`PUT /api/v1/settings/timezone`。設計 §4.1）。
 * 表示名の保存は「保存する」を押すだけだが、こちらは**確認を挟む不可逆な操作**である。
 *
 * **選択欄の中身はサーバーが組み立てて渡す**（`app/settings/page.tsx`）。
 * ブラウザの `Intl` 実装差・ICU の差が画面に出ない（設計 §5.3.2）。
 *
 * `canManage` による出し分けは**表示制御であって認可ではない。**
 * 認可は UseCase 側（`system.manage`）が行う。
 */

const SOURCE_LABEL: Record<AnalyticsTimeZoneSource, string> = {
  database: 'データベース',
  environment: '環境変数（TORIFUNE_TIMEZONE）',
  default: '既定（UTC）',
};

export interface TimeZoneSettingsProps {
  /** いま効いている値。 */
  readonly current: string;
  /** その出所。**必ず出す**（書かないと「env を変えたのに効かない」で迷う）。 */
  readonly source: AnalyticsTimeZoneSource;
  /** 選択肢（地域ごと）。 */
  readonly groups: readonly TimeZoneGroup[];
  readonly canManage: boolean;
  /**
   * 確認ダイアログを開いた状態で描くための入口（テスト用。既定は `null`）。
   *
   * **描画では 1 度も要求しない。** 数えるのは「変更する」を押したときだけ。
   */
  readonly initialPreview?: TimeZoneChangePreview | null;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 確認ダイアログの本文（設計 §7.2）。
 *
 * **プレビューを props に取るだけの純粋な部品として export する。**
 * 「押した後」に出る文言を、静的 HTML で決定的に検査できるようにするため。
 */
export function TimeZoneChangeDetails({ preview }: { readonly preview: TimeZoneChangePreview }) {
  const hasRebuildRange = preview.rebuildFrom !== null && preview.rebuildTo !== null;
  const lostRows = preview.lostCoreRows + preview.lostPluginRows;
  const noteStyle = { margin: '0 0 var(--tf-space-2)', lineHeight: 1.7 } as const;

  return (
    <div style={{ margin: 'var(--tf-space-4) 0' }}>
      <p style={noteStyle}>
        計算し直す期間：
        {hasRebuildRange
          ? `${preview.rebuildFrom} 〜 ${preview.rebuildTo}（${formatCount(preview.rebuildDays)} 日）`
          : 'ありません（生ログが残っていません）'}
      </p>

      {lostRows === 0 && preview.lostDays === 0 ? (
        <p style={noteStyle}>消える集計値：ありません。</p>
      ) : (
        <>
          <p style={noteStyle}>
            消える集計値：{formatCount(preview.lostSites)} サイト / {formatCount(preview.lostDays)}{' '}
            日分
            {preview.lostFrom !== null && preview.lostTo !== null
              ? `（${preview.lostFrom} 〜 ${preview.lostTo}。生ログが残っていません）`
              : ''}
          </p>
          <ul style={{ margin: '0 0 var(--tf-space-2)', paddingLeft: 'var(--tf-space-5)' }}>
            <li>Torifune の集計値 {formatCount(preview.lostCoreRows)} 行</li>
            <li>
              Plugin が入れた値 {formatCount(preview.lostPluginRows)} 行
              {preview.lostSources.length > 0 ? `（${preview.lostSources.join(', ')}）` : ''}
            </li>
          </ul>
        </>
      )}

      {/*
        **Plugin の値は本体では作り直せない。** Core の値は生ログのある期間なら
        作り直せるが、Plugin が取り込んだ値の元データは本体の中に無い（設計 §9.1）。
      */}
      {preview.lostPluginRows > 0 && (
        <p style={noteStyle}>
          <strong>
            Plugin が取り込んだ値も消えます。Plugin 側に取り込み直す手段が無ければ、その数値は
            永久に失われます。
          </strong>
        </p>
      )}

      {/*
        **仕組み上どうにもならない制約を先に伝える**（要件 §2.1、設計 §6.3）。
        訪問者ハッシュのソルトは保存していないので、洗い替えても完全には直らない。
      */}
      <p style={noteStyle}>
        ページビューは正確に計算し直せますが、訪問者数・セッション数・直帰率・滞在時間は、
        新しい区切りをまたぐ訪問者が別人として数えられるため、実際より多め（悪め）に出ます。
        変えた当日の訪問者数も、同じ理由で多めに出ます。
      </p>

      <p style={noteStyle}>
        件数は見積りです（この後で生ログが消えるとずれます）。実際の件数と進捗は、 設定 →
        一般の「定期実行」から確認できます。計算には時間がかかります。
      </p>
    </div>
  );
}

export function TimeZoneSettings({
  current,
  source,
  groups,
  canManage,
  initialPreview = null,
}: TimeZoneSettingsProps) {
  const [effective, setEffective] = useState<{ value: string; source: AnalyticsTimeZoneSource }>({
    value: current,
    source,
  });
  const [selected, setSelected] = useState(current);
  const [preview, setPreview] = useState<TimeZoneChangePreview | null>(initialPreview);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(timeZone: string): Promise<boolean> {
    const result = await apiRequest<TimeZoneUpdateResult>('/api/v1/settings/timezone', {
      method: 'PUT',
      body: { timeZone },
    });

    if (!result.ok) {
      setError(result.error.message);
      return false;
    }

    // 保存した値がそのまま「いま効いている値」になる（出所はデータベースへ固定される）。
    setEffective({ value: result.data.timeZone, source: 'database' });
    setSelected(result.data.timeZone);
    setToast({
      id: crypto.randomUUID(),
      tone: 'success',
      text: result.data.rebuildStarted
        ? '保存しました。集計の洗い替えを始めました。'
        : '保存しました。変更はありません。',
    });
    return true;
  }

  async function onChangeRequested(): Promise<void> {
    setError(null);
    setBusy(true);

    // 現在値と同じものを選んだときは確認を出さない（失われるものが無い）。
    if (selected === effective.value) {
      await save(selected);
      setBusy(false);
      return;
    }

    // **数えてからダイアログを出す。** 画面の描画では 1 度も数えない（設計 §7.2）。
    const counted = await apiRequest<TimeZoneChangePreview>(
      `/api/v1/settings/timezone?timeZone=${encodeURIComponent(selected)}`,
    );
    setBusy(false);

    if (!counted.ok) {
      setError(counted.error.message);
      return;
    }
    setPreview(counted.data);
  }

  async function onConfirm(): Promise<void> {
    const target = preview?.timeZone ?? selected;
    setPreview(null);
    setBusy(true);
    await save(target);
    setBusy(false);
  }

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>基準タイムゾーン</h2>

      <p style={{ margin: '0 0 var(--tf-space-4)', color: 'var(--tf-color-text-muted)' }}>
        集計の「1 日の境目」と、画面の「今日」を決めます。
      </p>

      <p style={{ margin: '0 0 var(--tf-space-4)' }}>
        現在の設定：{effective.value}（{SOURCE_LABEL[effective.source]}）
      </p>

      {error !== null && <Alert tone="danger">{error}</Alert>}

      <FormField
        label="タイムゾーン"
        description="地域ごとにまとまっています。括弧内は現在のオフセットです。"
      >
        {(fieldProps) => (
          <Select
            {...fieldProps}
            value={selected}
            disabled={!canManage}
            onChange={(event) => setSelected(event.target.value)}
          >
            {groups.map((group) => (
              <optgroup key={group.region} label={group.region}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
      </FormField>

      {canManage && (
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={() => void onChangeRequested()}
        >
          変更する
        </Button>
      )}

      <p
        style={{
          margin: 'var(--tf-space-4) 0 0',
          fontSize: 'var(--tf-text-caption)',
          color: 'var(--tf-color-text-subtle)',
          lineHeight: 1.6,
        }}
      >
        変えると、保存済みの集計値を新しい区切りで計算し直します。時間がかかります。
        進捗は下の「定期実行」で確認できます。
      </p>

      <ConfirmDialog
        open={preview !== null}
        title={preview === null ? '' : `基準タイムゾーンを ${preview.timeZone} に変えますか？`}
        message="保存済みの集計値を、新しい 1 日の区切りで計算し直します。"
        confirmLabel="変更する"
        onConfirm={() => void onConfirm()}
        onCancel={() => setPreview(null)}
      >
        {preview !== null && <TimeZoneChangeDetails preview={preview} />}
      </ConfirmDialog>

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </Card>
  );
}
