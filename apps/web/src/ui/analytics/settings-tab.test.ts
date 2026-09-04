import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsTab, type SettingsData } from './settings-tab';

/**
 * 設定タブの受信状況（029-scheduled-jobs 設計 §7.1.2、受け入れ条件 #53）。
 *
 * `SettingsData` に `state` / `pendingText` / `lastSucceededAt` / `lastRunStatus` / `scheduled` /
 * `intervalMinutes` / `nextRunAt` を足す。既存の `lastSeenAt`（生ログの最終受信の文字列）/ `lastRollupAt` は残す。
 *
 * | 行 | 表示 |
 * | --- | --- |
 * | 状態 | 未受信 / 受信中（集計待ち） / Bot のみ受信 / 受信中 |
 * | 最終受信 | `lastSeenAt`。無ければ — |
 * | 未集計の受信 | `pendingText`。無ければ — |
 * | 最終集計（全体） | `lastSucceededAt`。`lastRunStatus === 'error'` なら「（前回の実行は失敗）」、`'running'` なら「（実行中）」 |
 * | このサイトの集計値の最終更新 | `lastRollupAt` |
 * | 定期実行 | 「有効 · N 分ごと · 次回 YYYY-MM-DD HH:mm」/「無効（TORIFUNE_SCHEDULER=off）」 |
 *
 * `useRouter` を使う Client Component なので `next/navigation` を差し替える。静的 HTML の文字列で見る。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const BASE: SettingsData = {
  siteId: '01900000-0000-7000-8000-0000000000a1',
  publicKey: 'a'.repeat(64),
  scriptOrigin: 'https://torifune.example.com',
  canRegenerate: true,
  lastSeenAt: '2026-09-04 10:12',
  lastRollupAt: '2026-09-04 10:15',
  timeZone: 'UTC',
  state: 'receiving',
  pendingText: null,
  lastSucceededAt: '2026-09-04 10:16',
  lastRunStatus: 'ok',
  scheduled: true,
  intervalMinutes: 15,
  nextRunAt: '2026-09-04 10:30',
};

function render(overrides: Partial<SettingsData> = {}): string {
  return renderToStaticMarkup(createElement(SettingsTab, { data: { ...BASE, ...overrides } }));
}

/** タグを落として文字だけにする（`<code>` などで文言が分断されても見られるように）。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 「ラベル」で始まる行の値（次のラベルまで）。 */
function rowValue(html: string, label: string): string {
  const text = textOf(html);
  const start = text.indexOf(label);
  expect(start, `行「${label}」が無い`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + label.length);
  const next = rest.search(
    /最終受信|未集計の受信|最終集計（全体）|このサイトの集計値の最終更新|定期実行|日付の区切り|集計は|定期実行は無効/,
  );
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

describe('状態の行', () => {
  /** #53 */
  it.each([
    ['not-received', '未受信'],
    ['pending-rollup', '受信中（集計待ち）'],
    ['bots-only', 'Bot のみ受信'],
    ['receiving', '受信中'],
  ] as const)('state = %s で「%s」を出す', (state, label) => {
    expect(rowValue(render({ state }), '状態')).toBe(label);
  });

  /** #53。「受信中」と「受信中（集計待ち）」を混同しない。 */
  it("state = 'receiving' のとき「集計待ち」を出さない", () => {
    expect(textOf(render({ state: 'receiving' }))).not.toContain('集計待ち');
  });
});

describe('未集計の受信', () => {
  /** #53 */
  it('pendingText を出す', () => {
    const html = render({ state: 'pending-rollup', pendingText: '3 件（うち Bot 1 件）' });

    expect(rowValue(html, '未集計の受信')).toBe('3 件（うち Bot 1 件）');
  });

  /** #53 */
  it('pendingText が null なら —', () => {
    expect(rowValue(render({ pendingText: null }), '未集計の受信')).toBe('—');
  });

  /** #53。打ち切りと「集計したことがありません」の文言はそのまま出す（組み立ては page 側）。 */
  it('打ち切りの文言をそのまま出す', () => {
    const html = render({
      pendingText: '1,000 件以上（うち Bot 12 件以上）（集計したことがありません）',
    });

    expect(textOf(html)).toContain(
      '1,000 件以上（うち Bot 12 件以上）（集計したことがありません）',
    );
  });
});

describe('最終集計', () => {
  /** #53 */
  it('「最終集計（全体）」に lastSucceededAt を出す', () => {
    expect(rowValue(render(), '最終集計（全体）')).toBe('2026-09-04 10:16');
  });

  /** #53 */
  it('lastSucceededAt が null なら —', () => {
    expect(
      rowValue(render({ lastSucceededAt: null, lastRunStatus: null }), '最終集計（全体）'),
    ).toBe('—');
  });

  /** #53 */
  it("lastRunStatus === 'error' なら「（前回の実行は失敗）」を添える", () => {
    const value = rowValue(render({ lastRunStatus: 'error' }), '最終集計（全体）');

    expect(value).toContain('2026-09-04 10:16');
    expect(value).toContain('（前回の実行は失敗）');
  });

  /** #53 */
  it("lastRunStatus === 'running' なら「（実行中）」を添える", () => {
    expect(rowValue(render({ lastRunStatus: 'running' }), '最終集計（全体）')).toContain(
      '（実行中）',
    );
  });

  /** #53 */
  it("lastRunStatus === 'ok' なら注釈を添えない", () => {
    const value = rowValue(render({ lastRunStatus: 'ok' }), '最終集計（全体）');

    expect(value).not.toContain('失敗');
    expect(value).not.toContain('実行中');
  });

  /** #53（裁定 #7）。サイトごとの最終更新は別の行に残す。 */
  it('「このサイトの集計値の最終更新」に lastRollupAt を出す', () => {
    expect(rowValue(render(), 'このサイトの集計値の最終更新')).toBe('2026-09-04 10:15');
    expect(rowValue(render({ lastRollupAt: null }), 'このサイトの集計値の最終更新')).toBe('—');
  });

  /** #53 */
  it('最終受信に lastSeenAt を出す', () => {
    expect(rowValue(render(), '最終受信')).toBe('2026-09-04 10:12');
    expect(rowValue(render({ lastSeenAt: null }), '最終受信')).toBe('—');
  });
});

describe('定期実行', () => {
  /** #53 */
  it('有効なら「有効 · N 分ごと · 次回 YYYY-MM-DD HH:mm」', () => {
    expect(rowValue(render(), '定期実行')).toBe('有効 · 15 分ごと · 次回 2026-09-04 10:30');
  });

  /** #53 */
  it('無効なら「無効（TORIFUNE_SCHEDULER=off）」', () => {
    const html = render({ scheduled: false, nextRunAt: null });

    expect(rowValue(html, '定期実行')).toBe('無効（TORIFUNE_SCHEDULER=off）');
  });

  /** #53。注記（有効）。 */
  it('有効なら注記が「集計は Torifune が N 分ごとに自動で行います」で始まる', () => {
    const text = textOf(render());

    expect(text).toContain('集計は Torifune が 15 分ごとに自動で行います');
    expect(text).toContain('最大 7 日さかのぼります');
    expect(text).toContain('POST /api/v1/analytics/rollup');
    expect(text).not.toContain('定期実行は無効です。');
  });

  /** #53。注記（無効）。 */
  it('無効なら注記が「定期実行は無効です。」で始まる', () => {
    const text = textOf(render({ scheduled: false, nextRunAt: null }));

    expect(text).toContain('定期実行は無効です。');
    expect(text.indexOf('定期実行は無効です。')).toBeLessThan(
      text.indexOf('POST /api/v1/analytics/rollup'),
    );
    expect(text).not.toContain('分ごとに自動で行います');
  });

  /** 028 の「cron から毎日実行します」は消える。 */
  it('「cron から毎日実行します」を出さない', () => {
    expect(textOf(render())).not.toContain('cron から毎日実行します');
  });
});

describe('既存の項目', () => {
  it('計測タグと公開キーの再発行は従来どおり描かれる', () => {
    const html = render();

    expect(html).toContain('data-tracking-snippet');
    // 計測タグは `<pre>` の中の文字列（属性値は HTML エスケープされる）。
    expect(textOf(html)).toContain(`data-site="${'a'.repeat(64)}"`);
    expect(html).toContain('公開キーを再発行');
    expect(rowValue(html, '日付の区切り')).toBe('UTC');
  });
});
