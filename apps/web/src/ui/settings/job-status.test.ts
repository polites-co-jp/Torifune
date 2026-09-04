import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JobStatusCard, type JobStatusCardData } from './job-status';

/**
 * 設定画面「一般」タブの定期実行の区画（029-scheduled-jobs 設計 §7.2、受け入れ条件 #55）。
 *
 * 想定する props（実装プラン T16。日時は Server Component が文字列にして渡す）：
 *
 * ```ts
 * JobStatusCard({ data: {
 *   booted: boolean;
 *   enabled: boolean;
 *   jobs: { name, label, intervalMinutes, lastRunAt, lastRunStatus, lastSuccessAt, nextRunAt }[];
 *   recentErrors: { jobLabel, at, error }[];
 * } })
 * ```
 *
 * - 表は 2 行（アクセス解析の集計 / Webhook 配信）。結果は `Badge` を `<span data-job-status="…">` で包む
 * - 直近のエラーは新しい順に最大 5 件、200 文字で切る
 * - `booted: false` →「起動していません」、`enabled: false` →「無効（TORIFUNE_SCHEDULER=off）」
 * - 注記：「次回」はこの画面を返したプロセスの予定。実行はジョブごとのロックで 1 プロセスだけ
 */

const BASE: JobStatusCardData = {
  booted: true,
  enabled: true,
  jobs: [
    {
      name: 'analytics.rollup',
      label: 'アクセス解析の集計',
      intervalMinutes: 15,
      lastRunAt: '2026-09-04 10:15',
      lastRunStatus: 'ok',
      lastSuccessAt: '2026-09-04 10:15',
      nextRunAt: '2026-09-04 10:30',
    },
    {
      name: 'webhook.deliver',
      label: 'Webhook 配信',
      intervalMinutes: 1,
      lastRunAt: '2026-09-04 10:29',
      lastRunStatus: 'error',
      lastSuccessAt: '2026-09-04 10:28',
      nextRunAt: '2026-09-04 10:30',
    },
  ],
  recentErrors: [
    { jobLabel: 'Webhook 配信', at: '2026-09-04 10:29', error: '受け手が 503 を返した' },
  ],
};

function render(overrides: Partial<JobStatusCardData> = {}): string {
  return renderToStaticMarkup(createElement(JobStatusCard, { data: { ...BASE, ...overrides } }));
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

/** `<tr>` の中身（見出し行を含む）。 */
function rows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => textOf(match[1] ?? ''));
}

describe('JobStatusCard', () => {
  /** #55 */
  it('見出し「定期実行」と、ジョブ 2 行の表を描く', () => {
    const html = render();

    expect(html).toMatch(/<h2[^>]*>定期実行<\/h2>/);
    const body = rows(html).filter((row) => !row.includes('ジョブ'));
    expect(body).toHaveLength(2);
    expect(body[0]).toContain('アクセス解析の集計');
    expect(body[0]).toContain('15 分');
    expect(body[0]).toContain('2026-09-04 10:15');
    expect(body[0]).toContain('2026-09-04 10:30');
    expect(body[1]).toContain('Webhook 配信');
    expect(body[1]).toContain('1 分');
    expect(body[1]).toContain('2026-09-04 10:29');
    expect(body[1]).toContain('2026-09-04 10:28');
  });

  /** #55。列見出し。 */
  it('列見出しは ジョブ / 間隔 / 前回の実行 / 結果 / 前回の成功 / 次回', () => {
    const header = rows(render())[0] ?? '';

    for (const column of ['ジョブ', '間隔', '前回の実行', '結果', '前回の成功', '次回']) {
      expect(header).toContain(column);
    }
  });

  /** #55。E2E が結果を引くための属性。 */
  it('結果に data-job-status="<status>" を付ける', () => {
    const html = render();

    expect(html).toContain('data-job-status="ok"');
    expect(html).toContain('data-job-status="error"');
    expect(html).not.toContain('data-job-status="skipped"');
  });

  /** §7.2。結果の文言。 */
  it.each([
    ['ok', 'ok'],
    ['error', 'error'],
    ['skipped', 'スキップ'],
    ['running', '実行中'],
  ] as const)('lastRunStatus = %s を「%s」と出す', (status, label) => {
    const html = render({
      jobs: [{ ...BASE.jobs[0]!, lastRunStatus: status }],
      recentErrors: [],
    });

    const marker = `data-job-status="${status}"`;
    expect(html).toContain(marker);
    // 属性を付けた要素から、そのセルの終わりまでの文字。
    const start = html.indexOf(marker);
    const cell = html.slice(start, html.indexOf('</td>', start));
    expect(textOf(cell)).toContain(label);
  });

  /** #55。未実行。 */
  it('lastRunAt / lastRunStatus / lastSuccessAt が null なら — を出し、data-job-status は付けない', () => {
    const html = render({
      jobs: [
        {
          ...BASE.jobs[0]!,
          lastRunAt: null,
          lastRunStatus: null,
          lastSuccessAt: null,
          nextRunAt: null,
        },
      ],
      recentErrors: [],
    });

    const body = rows(html).filter((row) => !row.includes('ジョブ'));
    expect(body[0]).toContain('—');
    expect(html).not.toContain('data-job-status=');
  });

  /** #55 */
  it('直近のエラーをジョブ名・時刻・メッセージで出す', () => {
    const text = textOf(render());

    expect(text).toContain('直近のエラー');
    expect(text).toContain('Webhook 配信 2026-09-04 10:29');
    expect(text).toContain('受け手が 503 を返した');
  });

  /** #55。全文は `GET /api/v1/jobs`。画面は 200 文字で切る。 */
  it('直近のエラーのメッセージを 200 文字で切る', () => {
    const text = textOf(
      render({
        recentErrors: [
          {
            jobLabel: 'Webhook 配信',
            at: '2026-09-04 10:29',
            error: `${'a'.repeat(200)}${'b'.repeat(50)}`,
          },
        ],
      }),
    );

    expect(text).toContain('a'.repeat(200));
    expect(text).not.toContain('bbbbb');
  });

  /** §7.2。エラーが無ければ見出しを出さない。 */
  it('recentErrors が空なら「直近のエラー」を出さない', () => {
    expect(textOf(render({ recentErrors: [] }))).not.toContain('直近のエラー');
  });

  /** #55 */
  it('booted: false なら「起動していません」', () => {
    const text = textOf(render({ booted: false, enabled: false }));

    expect(text).toContain('起動していません');
    expect(text).not.toContain('定期実行は有効です');
  });

  /** §7.2 */
  it('enabled: false なら「無効（TORIFUNE_SCHEDULER=off）」', () => {
    const text = textOf(render({ booted: true, enabled: false }));

    expect(text).toContain('無効（TORIFUNE_SCHEDULER=off）');
    expect(text).not.toContain('定期実行は有効です');
  });

  /** §7.2 */
  it('有効なら「定期実行は有効です（このプロセス）」', () => {
    expect(textOf(render())).toContain('定期実行は有効です（このプロセス）');
  });

  /** §7.2。複数プロセスの注記。 */
  it('注記に「この画面を返したプロセスの予定」と「1 プロセスだけ」がある', () => {
    const text = textOf(render());

    expect(text).toContain('この画面を返したプロセスの予定');
    expect(text).toContain('1 プロセスだけ');
  });
});
