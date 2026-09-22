import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ManualPendingReminder } from './core-widgets';

/**
 * ダッシュボードの「手動投稿待ち」の導線
 * （035-social-publishing 設計 §7.6、受け入れ条件 #72）。
 *
 * ```ts
 * ManualPendingReminder({ count: number })
 * ```
 *
 * **操作は置かない。** 「投稿した／取りやめ」は `/social` の区画だけに置く
 * （2 か所に置くと片方だけ直す事故が起きる。設計 §7.1）。
 * ここに出すのは**件数と導線だけ**で、0 件なら何も描かない。
 *
 * `app/dashboard/page.tsx` が `social.read` のときだけ
 * `listManualPendingPosts({ limit: 1 })` の `total` を取って渡す。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function render(count: number): string {
  return renderToStaticMarkup(createElement(ManualPendingReminder, { count }));
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

describe('ManualPendingReminder', () => {
  it('#72 count: 2 で「手動投稿待ちが 2 件あります」を出す', () => {
    expect(textOf(render(2))).toMatch(/手動投稿待ちが\s*2\s*件あります/);
  });

  it('#72 SNS 画面で投稿するよう促す', () => {
    expect(textOf(render(2))).toContain('SNS 画面で投稿してください');
  });

  it('#72 /social#manual-pending へのリンクを出す', () => {
    // 区画そのものへ飛ばす（設計 §7.1 の `id="manual-pending"`）。
    expect(render(2)).toContain('href="/social#manual-pending"');
  });

  it('#72 count: 1 でも出す', () => {
    expect(textOf(render(1))).toMatch(/手動投稿待ちが\s*1\s*件あります/);
  });

  it('#72 count: 0 なら何も描かない', () => {
    expect(render(0)).toBe('');
  });

  it('#72 注意として出す（tone="warning" の Alert）', () => {
    // その時刻に人が動かないと投稿されない（設計 §7.6）。
    expect(render(2)).toContain('role="status"');
  });
});
