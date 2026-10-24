import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SocialPosts, type PostRow, type SocialPostsProps } from './social-posts';

/**
 * 投稿タブの状態の補足のリンク（055-social-pending-tab 設計 §9.8、受け入れ条件 #59、実装プラン §8 の 27）。
 *
 * 承認待ち・手動投稿待ちの区画は無くなり、送信待ちタブの表に吸収された（ユーザー裁定 3）。投稿一覧（`SocialPosts`）の
 * 状態の補足は区画のアンカー（`#approval-pending`・`#manual-pending`）から、送信待ちタブの絞り込みへ向ける。
 *
 * * 承認待ちの行：「（送信待ちで承認）」で `/social?pendingStatus=awaiting_approval`
 * * 手動投稿待ちの行：「手動投稿待ち」（同じ文言）で `/social?pendingStatus=manual_pending`
 * * どちらも `#` を含まない（アンカーの読み替えはしない。設計 §9.8）
 *
 * `/social?pendingStatus=…` は `&` を含まないので、HTML のエスケープを気にせず `href="…"` で見る（§8 の 27）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000055a1';

const APPROVAL_HREF = '/social?pendingStatus=awaiting_approval';
const MANUAL_HREF = '/social?pendingStatus=manual_pending';

let sequence = 0;

function post(overrides: Partial<PostRow> = {}): PostRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000055${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `投稿の本文 ${suffix}`,
    scheduledAt: '2026-10-20T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    externalUrl: null,
    skipCount: 0,
    ...overrides,
  };
}

const AWAITING = post({ status: 'awaiting_approval', body: '承認待ちの投稿' });
const MANUAL_PENDING = post({
  status: 'scheduled',
  deliveryMode: 'manual',
  manualPending: true,
  body: '手動投稿待ちの投稿',
});
const DRAFT = post({ status: 'draft', body: '下書きの投稿' });
const SCHEDULED = post({ status: 'scheduled', body: '予約済みの投稿' });

const BASE: SocialPostsProps = {
  initialPosts: [AWAITING, MANUAL_PENDING, DRAFT, SCHEDULED],
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  accountProviders: { [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true } },
  publisherProviders: {
    testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
  },
  total: 4,
  page: 1,
  perPage: 20,
  permissions: ['social.read', 'social.write', 'social.approve', 'social.delete'],
};

function render(initialPosts: readonly PostRow[] = BASE.initialPosts): string {
  return renderToStaticMarkup(createElement(SocialPosts, { ...BASE, initialPosts }));
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

/** 本体の行（見出しの行を除く）の HTML。 */
function bodyRows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[0])
    .filter((row) => !row.includes('<th'));
}

function rowOf(html: string, body: string): string {
  const rows = bodyRows(html).filter((row) => textOf(row).includes(body));
  expect(rows, `本文「${body}」の行`).toHaveLength(1);
  return rows[0] as string;
}

/** 行の中の `<a>`（開始タグと見える文字）。 */
function anchors(html: string): { readonly openTag: string; readonly text: string }[] {
  return [...html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/g)].map((match) => ({
    openTag: match[1] as string,
    text: textOf(match[2] as string).trim(),
  }));
}

describe('#59 投稿一覧の承認待ちの行の補足', () => {
  it('#59 補足が「（送信待ちで承認）」', () => {
    expect(textOf(rowOf(render(), AWAITING.body))).toContain('（送信待ちで承認）');
  });

  it('#59 「（区画で承認）」は出さない（区画は無くなった）', () => {
    expect(textOf(render())).not.toContain('区画で承認');
  });

  it('#59 補足は /social?pendingStatus=awaiting_approval へのリンク', () => {
    const link = anchors(rowOf(render(), AWAITING.body)).find((anchor) =>
      anchor.text.includes('送信待ちで承認'),
    );

    expect(link, '「（送信待ちで承認）」のリンク').toBeDefined();
    expect(link?.openTag).toContain(`href="${APPROVAL_HREF}"`);
  });

  it('#59 承認待ちの行のリンクは # を含まない', () => {
    for (const anchor of anchors(rowOf(render(), AWAITING.body))) {
      expect(anchor.openTag, anchor.text).not.toMatch(/href="[^"]*#/);
    }
  });

  it('#59 承認待ちでない行に送信待ちの承認待ちへのリンクを出さない', () => {
    expect(render([DRAFT, SCHEDULED, MANUAL_PENDING])).not.toContain(`href="${APPROVAL_HREF}"`);
  });
});

describe('#59 投稿一覧の手動投稿待ちの行の補足', () => {
  it('#59 補足が「手動投稿待ち」で /social?pendingStatus=manual_pending へのリンク', () => {
    const link = anchors(rowOf(render(), MANUAL_PENDING.body)).find(
      (anchor) => anchor.text === '手動投稿待ち',
    );

    expect(link, '「手動投稿待ち」のリンク').toBeDefined();
    expect(link?.openTag).toContain(`href="${MANUAL_HREF}"`);
  });

  it('#59 手動投稿待ちの行のリンクは # を含まない', () => {
    for (const anchor of anchors(rowOf(render(), MANUAL_PENDING.body))) {
      expect(anchor.openTag, anchor.text).not.toMatch(/href="[^"]*#/);
    }
  });

  it('#59 手動投稿待ちでない行に送信待ちの手動投稿待ちへのリンクを出さない', () => {
    expect(render([AWAITING, DRAFT, SCHEDULED])).not.toContain(`href="${MANUAL_HREF}"`);
  });
});

describe('#59 区画のアンカーへのリンクが無い', () => {
  it('#59 #approval-pending・#manual-pending へのリンクを出さない', () => {
    const html = render();

    expect(html).not.toContain('#approval-pending');
    expect(html).not.toContain('#manual-pending');
  });
});
