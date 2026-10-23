import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaginationProps } from '@/ui/components';
import { SocialAccounts, type SocialAccountsProps } from './social-accounts';
import { SocialHistory, type HistoryRow, type SocialHistoryProps } from './social-history';

/**
 * アカウントタブ・配信履歴タブの中身（055-social-pending-tab 設計 §9.1・§9.6、受け入れ条件 #58、実装プラン §8 の 19・49）。
 *
 * h1「SNS」はページ（`app/social/page.tsx`）に 1 つで、タブの上に置く。タブの中身の部品は h1 を持たない。
 *
 * * `SocialAccounts`：h1 を外す。「+ アカウントを追加」は今までどおり（`social.write`）
 * * `SocialHistory`：見出しを h2「配信履歴」にし、「SNSへ戻る」を外す。絞り込みの `<form method="get">` に
 *   `<input type="hidden" name="tab" value="history">` を足し、`select` の `name` を `historyStatus` にする
 *   （送ると `tab` が落ちて送信待ちへ戻るのを防ぐ）。ページ送りは `/social?tab=history…`（`historyListHref`）
 *
 * ページ送りは `@/ui/components` の `Pagination` を包んで `onChange` を捕まえ、`window.location.assign` を
 * 差し替えて開く URL を見る（`post-list-params.test.ts` の #76 と同じ）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const capture = vi.hoisted(() => ({ paginations: [] as unknown[] }));

vi.mock('@/ui/components', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/components');
  const Pagination = actual['Pagination'] as (props: PaginationProps) => ReactNode;
  return {
    ...actual,
    Pagination: (props: PaginationProps) => {
      capture.paginations.push(props);
      return Pagination(props);
    },
  };
});

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

beforeEach(() => {
  capture.paginations.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* SocialAccounts                                                               */
/* -------------------------------------------------------------------------- */

const ACCOUNTS_BASE: SocialAccountsProps = {
  initialAccounts: [
    {
      id: '01900000-0000-7000-8000-0000000055a1',
      provider: 'bluesky',
      displayName: 'とりふね公式',
      handle: '@torifune',
      status: 'connected',
      credentialConfigured: true,
    },
  ],
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: [{ value: 'bluesky', label: 'Bluesky', credentialFields: [] }],
};

function renderAccounts(overrides: Partial<SocialAccountsProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialAccounts, { ...ACCOUNTS_BASE, ...overrides }));
}

describe('#58 アカウントタブ（SocialAccounts）', () => {
  it('#58 h1 を持たない（h1「SNS」はページに 1 つ）', () => {
    expect(renderAccounts()).not.toMatch(/<h1\b/);
  });

  it('#58 アカウントが 0 件でも h1 を持たない', () => {
    expect(renderAccounts({ initialAccounts: [] })).not.toMatch(/<h1\b/);
  });

  it('#58 social.write なら「+ アカウントを追加」がある（今までどおり）', () => {
    expect(textOf(renderAccounts())).toContain('+ アカウントを追加');
  });

  it('#58 social.write が無ければ「+ アカウントを追加」が無い', () => {
    expect(textOf(renderAccounts({ permissions: ['social.read'] }))).not.toContain(
      '+ アカウントを追加',
    );
  });

  it('#58 アカウントの一覧は今までどおり出る', () => {
    expect(textOf(renderAccounts())).toContain('とりふね公式');
  });
});

/* -------------------------------------------------------------------------- */
/* SocialHistory                                                                */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000055a1';

const HISTORY_ROWS: readonly HistoryRow[] = [
  {
    id: '01900000-0000-7000-8000-0000000055h1',
    socialAccountId: ACCOUNT_ID,
    body: '配信済みの投稿',
    status: 'published',
    resultAt: '2026-10-23T01:00:00.000Z',
    failureReason: null,
    externalUrl: null,
  },
  {
    id: '01900000-0000-7000-8000-0000000055h2',
    socialAccountId: ACCOUNT_ID,
    body: '投稿しなかった手動投稿',
    status: 'failed',
    resultAt: '2026-10-23T02:00:00.000Z',
    failureReason: '手動投稿で『投稿しなかった』が選ばれました。',
    externalUrl: null,
  },
];

const HISTORY_BASE: SocialHistoryProps = {
  rows: HISTORY_ROWS,
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  total: 45,
  page: 1,
  perPage: 20,
  status: '',
};

function renderHistory(overrides: Partial<SocialHistoryProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialHistory, { ...HISTORY_BASE, ...overrides }));
}

/** 絞り込みの `<form>`（`method="get"`）。 */
function historyForm(html: string): string {
  return /<form\b[^>]*method="get"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
}

function inputs(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
}

describe('#58 配信履歴タブ（SocialHistory）', () => {
  it('#58 見出しが h2「配信履歴」', () => {
    expect(renderHistory()).toMatch(/<h2\b[^>]*>配信履歴<\/h2>/);
  });

  it('#58 h1 を持たない', () => {
    expect(renderHistory()).not.toMatch(/<h1\b/);
  });

  it('#58 「SNSへ戻る」が無い（タブで移れる）', () => {
    expect(textOf(renderHistory())).not.toContain('SNSへ戻る');
  });

  it('#58 /social/history へのリンクを書かない', () => {
    expect(renderHistory()).not.toContain('href="/social/history');
  });

  it('#58 絞り込みの form に <input type="hidden" name="tab" value="history"> がある', () => {
    const hidden = inputs(historyForm(renderHistory())).filter((tag) => /type="hidden"/.test(tag));

    expect(hidden.some((tag) => /name="tab"/.test(tag) && /value="history"/.test(tag))).toBe(true);
  });

  it('#58 絞り込みの select の name が historyStatus（status ではない）', () => {
    const form = historyForm(renderHistory());

    expect(form).toMatch(/<select\b[^>]*name="historyStatus"/);
    expect(form).not.toMatch(/<select\b[^>]*name="status"/);
  });

  it('#58 今の結果の条件が選ばれている（failed）', () => {
    const form = historyForm(renderHistory({ status: 'failed' }));

    expect(form).toMatch(/<option\b[^>]*value="failed"[^>]*selected/);
  });

  it('#58 失敗の理由の列に「投稿しなかった」の固定の理由が出る（設計 §9.6）', () => {
    expect(textOf(renderHistory())).toContain('手動投稿で『投稿しなかった』が選ばれました。');
  });

  it('#58 ページ送り（すべて）が /social?tab=history&historyPage=2 を開く', () => {
    renderHistory();
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const pagination = (capture.paginations as PaginationProps[])[0];

    expect(pagination, 'Pagination').toBeDefined();
    pagination?.onChange(2);

    expect(assign.mock.calls).toEqual([['/social?tab=history&historyPage=2']]);
  });

  it('#58 ページ送り（失敗で絞り込み中）が /social?tab=history&historyStatus=failed&historyPage=3 を開く', () => {
    renderHistory({ status: 'failed' });
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });

    (capture.paginations as PaginationProps[])[0]?.onChange(3);

    expect(assign.mock.calls).toEqual([['/social?tab=history&historyStatus=failed&historyPage=3']]);
  });

  it('#58 1 ページ目へ戻るページ送りは /social?tab=history（配信履歴タブのまま）', () => {
    renderHistory({ page: 2 });
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });

    (capture.paginations as PaginationProps[])[0]?.onChange(1);

    expect(assign.mock.calls).toEqual([['/social?tab=history']]);
  });
});
