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
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const SETTINGS_HREF = '/analytics?siteId=site-1&tab=settings';

const BASE: NotTrackedData = {
  state: 'not-received',
  lastReceivedAt: null,
  pendingText: null,
  scheduled: true,
  intervalMinutes: 15,
  nextRunAt: '2026-09-04 10:30',
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
