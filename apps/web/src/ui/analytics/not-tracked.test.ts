import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NotTracked, type NotTrackedData } from './not-tracked';

/**
 * 導線の 3 状態（029-scheduled-jobs 設計 §7.1.3、受け入れ条件 #54）。
 *
 * props に `data: NotTrackedData`（`state` / `lastReceivedAt` / `pendingText` / `scheduled` /
 * `intervalMinutes` / `nextRunAt`）を足す。既存の `settingsHref` / `canOpenSettings` は残す。
 *
 * - `not-received`：Badge「計測タグ未設置」、h2「まだアクセスの記録がありません」、Button「計測タグを取得」（既存 E2E の locator を保つ）
 * - `pending-rollup`：Badge「受信済み・集計待ち」、h2「アクセスは届いています。集計を待っています」、ボタン無し、リンク「受信状況を見る」
 * - `bots-only`：Badge「Bot のみ受信」、h2「届いたアクセスはすべて Bot と判定されています」、ボタン無し、同じリンク
 *
 * **030-analytics-today 設計 §7.5 で 2 フィールドを足した**（受け入れ条件 #63 / #64）：
 *
 * ```ts
 * interface NotTrackedData {
 *   // …既存…
 *   readonly receivedToday: boolean;      // 最終受信が運用タイムゾーンの今日か
 *   readonly todayHref: string | null;    // 「当日」（?period=today）への導線。当期が既に当日なら null
 * }
 * ```
 *
 * プリセットの `to` が昨日になったので、計測を始めた初日は `7d` が空になる。
 * この状態を**「集計待ち」と誤って説明しない**。
 * **`receivedToday` が真のとき「次回の集計のあとに数字が出ます」と書いてはならない。**
 * 次の集計が走っても、今日の分は末尾が昨日の期間には入らないので、その文は嘘になる。
 *
 * `not-received` は**現行のまま**（既存 E2E の locator を保つ。#64）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const SETTINGS_HREF = '/analytics?siteId=site-1&tab=settings';
const TODAY_HREF = '/analytics?siteId=site-1&period=today';

const BASE: NotTrackedData = {
  state: 'not-received',
  lastReceivedAt: null,
  pendingText: null,
  scheduled: true,
  intervalMinutes: 15,
  nextRunAt: '2026-09-04 10:30',
  receivedToday: false,
  todayHref: TODAY_HREF,
};

function render(
  overrides: Partial<NotTrackedData> = {},
  props: { readonly canOpenSettings?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(NotTracked, {
      settingsHref: SETTINGS_HREF,
      canOpenSettings: props.canOpenSettings ?? true,
      data: { ...BASE, ...overrides },
    }),
  );
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function headingOf(html: string): string {
  return textOf(/<h2\b[^>]*>([\s\S]*?)<\/h2>/.exec(html)?.[1] ?? '');
}

describe('not-received（計測タグ未設置）', () => {
  /** #54。既存の文言を保つ。 */
  it('「計測タグ未設置」「まだアクセスの記録がありません」「計測タグを取得」を出す', () => {
    const html = render({ state: 'not-received' });

    expect(textOf(html)).toContain('計測タグ未設置');
    expect(headingOf(html)).toBe('まだアクセスの記録がありません');
    expect(html).toMatch(/<button[^>]*>計測タグを取得<\/button>/);
  });

  /** #54 / §7.1.3。説明に定期実行の間隔が入る。 */
  it('有効なら説明に「N 分ごとに自動で行います」が入る', () => {
    const text = textOf(render({ state: 'not-received', scheduled: true, intervalMinutes: 15 }));

    expect(text).toContain('15 分ごとに自動で行います');
    expect(text).toContain('計測タグをサイトへ貼る必要があります');
    expect(text).toContain('次回の集計（10:30 頃）のあとに数字が出ます');
  });

  /** §7.1.3。無効時は API での集計を案内する。 */
  it('無効なら「定期実行が無効なので、集計は POST /api/v1/analytics/rollup で行ってください」', () => {
    const text = textOf(render({ state: 'not-received', scheduled: false, nextRunAt: null }));

    expect(text).toContain('定期実行が無効なので');
    expect(text).toContain('POST /api/v1/analytics/rollup');
    expect(text).toContain('集計 API を実行すると数字が出ます');
    expect(text).not.toContain('分ごとに自動で行います');
  });

  /** 028 の「cron から API トークンで叩けます」は消える。 */
  it('「cron」の案内を出さない', () => {
    expect(textOf(render({ state: 'not-received' }))).not.toContain('cron');
  });

  /** 既存。site.read が無ければ管理者に依頼する旨。 */
  it('canOpenSettings が false なら「管理者に依頼してください」でボタンを出さない', () => {
    const html = render({ state: 'not-received' }, { canOpenSettings: false });

    expect(textOf(html)).toContain('管理者に依頼してください');
    expect(html).not.toContain('計測タグを取得');
  });
});

describe('pending-rollup（受信済み・集計待ち）', () => {
  const data: Partial<NotTrackedData> = {
    state: 'pending-rollup',
    lastReceivedAt: '2026-09-04 10:12',
    pendingText: '3 件（うち Bot 1 件）',
  };

  /** #54 */
  it('「アクセスは届いています」を出し、「計測タグを取得」を出さない', () => {
    const html = render(data);

    expect(headingOf(html)).toContain('アクセスは届いています');
    expect(textOf(html)).toContain('受信済み・集計待ち');
    expect(html).not.toContain('計測タグを取得');
    expect(html).not.toContain('<button');
  });

  /** #54 / §7.1.3。最終受信・未集計・次回。 */
  it('説明に最終受信・未集計件数・次回の集計時刻が入る', () => {
    const text = textOf(render(data));

    expect(text).toContain('最終受信 2026-09-04 10:12');
    expect(text).toContain('未集計 3 件（うち Bot 1 件）');
    expect(text).toContain('次回の集計は 10:30 頃');
  });

  /** §7.1.3。無効時。 */
  it('無効なら「定期実行が無効です」と API の案内', () => {
    const text = textOf(render({ ...data, scheduled: false, nextRunAt: null }));

    expect(text).toContain('定期実行が無効です');
    expect(text).toContain('POST /api/v1/analytics/rollup');
    expect(text).not.toContain('次回の集計は');
  });

  /** §7.1.3。設定タブへのリンク。 */
  it('「受信状況を見る」のリンクが設定タブを指す', () => {
    const html = render(data);

    // 属性値の `&` は `&amp;` になる。
    const href = SETTINGS_HREF.replace('&', '&amp;').replace('?', '\\?');
    expect(html).toMatch(new RegExp(`<a[^>]*href="${href}"[^>]*>受信状況を見る</a>`));
  });

  /** §7.1.3。site.read が無ければリンクも出さない。 */
  it('canOpenSettings が false なら「受信状況を見る」を出さない', () => {
    expect(render(data, { canOpenSettings: false })).not.toContain('受信状況を見る');
  });
});

describe('bots-only（Bot のみ受信）', () => {
  const data: Partial<NotTrackedData> = {
    state: 'bots-only',
    lastReceivedAt: '2026-09-04 10:12',
    pendingText: '2 件（うち Bot 2 件）',
  };

  /** #54 */
  it('「すべて Bot と判定」を出し、「計測タグを取得」を出さない', () => {
    const html = render(data);

    expect(headingOf(html)).toContain('すべて Bot と判定');
    expect(textOf(html)).toContain('Bot のみ受信');
    expect(html).not.toContain('計測タグを取得');
    expect(html).not.toContain('<button');
  });

  /** §7.1.3。判定の理由と確かめ方。 */
  it('説明に User-Agent の条件と「実際のブラウザで」が入る', () => {
    const text = textOf(render(data));

    expect(text).toContain('最終受信 2026-09-04 10:12');
    expect(text).toContain('User-Agent');
    expect(text).toContain('実際のブラウザでページを開いて確かめてください');
    expect(text).toContain('「Bot を集計に含める」');
  });

  /** §7.1.3。同じリンク。 */
  it('「受信状況を見る」のリンクを出す', () => {
    expect(textOf(render(data))).toContain('受信状況を見る');
  });
});

/**
 * 前日までが空で、今日だけアクセスがある状態（030 設計 §7.5、受け入れ条件 #63）。
 *
 * `receivedToday` で文言を出し分け、「当日を見る」を添える。
 * **`not-received` は変えない**（#64）。
 */
describe('届いているのが今日の分だけのとき（#63）', () => {
  const PENDING_TODAY: Partial<NotTrackedData> = {
    state: 'pending-rollup',
    lastReceivedAt: '2026-09-05 10:12',
    pendingText: '3 件（うち Bot 1 件）',
    receivedToday: true,
  };

  const BOTS_TODAY: Partial<NotTrackedData> = {
    state: 'bots-only',
    lastReceivedAt: '2026-09-05 10:12',
    pendingText: '2 件（うち Bot 2 件）',
    receivedToday: true,
  };

  /** #63。「届いているのは今日の分です」。 */
  it('pending-rollup で receivedToday なら「届いているのは今日の分です」を出す', () => {
    const text = textOf(render(PENDING_TODAY));

    expect(text).toContain('届いているのは今日の分です');
    expect(text).toContain('確定値はまだありません');
  });

  /**
   * #63。**ここが要点。** 次の集計が走っても、今日の分は末尾が昨日の期間には入らない。
   * 「次回の集計のあとに数字が出ます」は嘘になる。
   */
  it('pending-rollup で receivedToday なら「次回の集計」を待たせない', () => {
    const text = textOf(render(PENDING_TODAY));

    expect(text).not.toContain('次回の集計');
    expect(text).not.toContain('そのあとにこの画面へ数字が出ます');
  });

  /** #63。「当日」への導線。 */
  it('pending-rollup で receivedToday なら「当日を見る」が ?period=today を指す', () => {
    const html = render(PENDING_TODAY);

    expect(textOf(html)).toContain('当日を見る');
    expect(html).toContain('period=today');
  });

  /** #63。当期が既に当日なら導線を出さない（自分自身へのリンクにしない）。 */
  it('todayHref が null なら「当日を見る」を出さない', () => {
    expect(textOf(render({ ...PENDING_TODAY, todayHref: null }))).not.toContain('当日を見る');
  });

  /** #63。今日でなければ現行どおり「次回の集計は {HH:mm} 頃」。 */
  it('pending-rollup で receivedToday でなければ現行どおり次回の集計を案内する', () => {
    const text = textOf(
      render({ ...PENDING_TODAY, receivedToday: false, lastReceivedAt: '2026-09-04 10:12' }),
    );

    expect(text).toContain('次回の集計は 10:30 頃');
    expect(text).toContain('そのあとにこの画面へ数字が出ます');
    expect(text).not.toContain('届いているのは今日の分です');
    expect(text).not.toContain('当日を見る');
  });

  /** #63。bots-only は現行の Bot の説明を残したうえで、今日の分であることを足す。 */
  it('bots-only で receivedToday なら Bot の説明に「届いたアクセスは今日の分です」を足す', () => {
    const text = textOf(render(BOTS_TODAY));

    expect(text).toContain('届いたアクセスは今日の分です');
    expect(text).toContain('「当日」でも同じく Bot だけが見えます');
    // 現行の Bot の説明は残す。
    expect(text).toContain('User-Agent');
    expect(text).toContain('実際のブラウザでページを開いて確かめてください');
  });

  /** #63。bots-only にも「当日を見る」を添える。 */
  it('bots-only で receivedToday なら「当日を見る」を出す', () => {
    expect(textOf(render(BOTS_TODAY))).toContain('当日を見る');
  });

  /** #63。今日でなければ Bot の説明はそのまま。 */
  it('bots-only で receivedToday でなければ今日の分の説明を出さない', () => {
    const text = textOf(render({ ...BOTS_TODAY, receivedToday: false }));

    expect(text).not.toContain('届いたアクセスは今日の分です');
    expect(text).not.toContain('当日を見る');
    expect(text).toContain('User-Agent');
  });
});

/**
 * #64。一度も受信していないサイトは、当日でも現行どおりの導線を出す。
 *
 * **既存 E2E の locator（Badge / h2 / Button の文言）を保つ。**
 * `receivedToday` は `lastReceivedAt === null` のとき必ず偽なので、この状態には効かない。
 */
describe('not-received は変えない（#64）', () => {
  /** #64 */
  it.each([false, true])(
    'receivedToday が %s でも Badge / 見出し / ボタンの文言が変わらない',
    (receivedToday) => {
      const html = render({ state: 'not-received', receivedToday });

      expect(textOf(html)).toContain('計測タグ未設置');
      expect(headingOf(html)).toBe('まだアクセスの記録がありません');
      expect(html).toMatch(/<button[^>]*>計測タグを取得<\/button>/);
    },
  );

  /** #64。今日の分の文言も「当日を見る」も出さない（一度も届いていないので嘘になる）。 */
  it('not-received では「届いているのは今日の分です」も「当日を見る」も出さない', () => {
    const text = textOf(render({ state: 'not-received' }));

    expect(text).not.toContain('届いているのは今日の分です');
    expect(text).not.toContain('当日を見る');
  });

  /** #64。3 ステップ（タグを貼る → 受信を確かめる → 集計を待つ）も現行のまま。 */
  it('not-received の 3 ステップが現行のまま出る', () => {
    const text = textOf(render({ state: 'not-received' }));

    expect(text).toContain('タグを貼る');
    expect(text).toContain('受信を確かめる');
    expect(text).toContain('集計を待つ');
  });
});
