import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPendingReminder, RecentPosts } from './core-widgets';

/**
 * ダッシュボードの「承認待ち」の案内（048-social-post-approval 設計 §7.5。ユーザー裁定 11、受け入れ条件 #71）と、
 * 「最近の投稿」の状態名（実装プラン §8 の要裁定 2。推奨どおり「承認待ち」を出すと裁定された）。
 *
 * ```ts
 * ApprovalPendingReminder({ count: number })
 * ```
 *
 * `app/dashboard/page.tsx` が `social.read` のときだけ `listApprovalPendingPosts({ limit: 1 })` の `total` を取って渡す。
 * 0 件なら何も描かない（`ManualPendingReminder` と同じ形）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function render(count: number): string {
  return renderToStaticMarkup(createElement(ApprovalPendingReminder, { count }));
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

describe('#71 ApprovalPendingReminder', () => {
  it('#71 count: 3 で「承認待ちの投稿が 3 件あります」を出す', () => {
    expect(textOf(render(3))).toMatch(/承認待ちの投稿が\s*3\s*件あります/);
  });

  it('#71 SNS 画面で確かめるよう促す', () => {
    expect(textOf(render(3))).toContain('SNS 画面で確かめてください');
  });

  it('#71 /social#approval-pending へのリンクを出す', () => {
    expect(render(3)).toContain('href="/social#approval-pending"');
  });

  it('#71 count: 1 でも出す', () => {
    expect(textOf(render(1))).toMatch(/承認待ちの投稿が\s*1\s*件あります/);
  });

  it('#71 count: 0 なら何も描かない', () => {
    expect(render(0)).toBe('');
  });

  it('#71 info の Alert として出す（role="status"）', () => {
    expect(render(3)).toContain('role="status"');
  });
});

describe('ダッシュボードの「最近の投稿」の状態名（要裁定 2）', () => {
  it('awaiting_approval の投稿を「承認待ち」と出す（英字のまま出さない）', () => {
    const html = renderToStaticMarkup(
      createElement(RecentPosts, {
        posts: [
          {
            id: '01900000-0000-7000-8000-0000000000d1',
            body: '承認を待つ投稿',
            status: 'awaiting_approval',
            updatedAt: '2026-09-30 10:12',
          },
        ],
      }),
    );

    expect(textOf(html)).toContain('承認待ち');
    expect(textOf(html)).not.toContain('awaiting_approval');
  });
});
