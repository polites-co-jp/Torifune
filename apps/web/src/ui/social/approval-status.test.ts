import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SocialPostForm, type AccountOption, type SocialPostFormProps } from './social-post-form';
import { SocialPosts, type PostRow, type SocialPostsProps } from './social-posts';

/**
 * 投稿一覧と投稿フォームの承認待ちの追随（048-social-post-approval 設計 §7.3・§7.4、受け入れ条件 #69・#70）。
 *
 * 足す props（実装プラン T21・§8 の 12。どちらも任意）：
 *
 * ```ts
 * PostRow.approvedAt?: string | null              // 承認した時刻（ISO）
 * SocialPostFormValues.approvedAtIso?: string | null
 * ```
 */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000000a1';
const NO_PUBLISHER_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000a2';
const POST_ID = '01900000-0000-7000-8000-0000000000b1';

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: POST_ID,
    socialAccountId: ACCOUNT_ID,
    body: '新製品のお知らせ',
    scheduledAt: '2026-10-01T00:00:00.000Z',
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

const LIST_BASE: SocialPostsProps = {
  initialPosts: [post()],
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）', [NO_PUBLISHER_ACCOUNT_ID]: '公式（X）' },
  accountProviders: {
    [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true },
    [NO_PUBLISHER_ACCOUNT_ID]: { provider: 'x', credentialConfigured: false },
  },
  publisherProviders: {
    testsns: {
      label: 'テストSNS',
      manual: true,
      publish: true,
      credentialFieldKeys: ['identifier', 'appPassword'],
    },
  },
  total: 1,
  page: 1,
  perPage: 20,
  permissions: ['social.read', 'social.write', 'social.delete'],
};

function renderList(initialPosts: readonly PostRow[]): string {
  return renderToStaticMarkup(createElement(SocialPosts, { ...LIST_BASE, initialPosts }));
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

/** `<tr>` の中身の文字（見出し行を含む）。 */
function rows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => textOf(match[1] ?? ''));
}

// ---------------------------------------------------------------------------
// #69 投稿一覧
// ---------------------------------------------------------------------------

describe('#69 投稿一覧の承認待ちの行', () => {
  it('#69 状態を「承認待ち」と出す', () => {
    expect(rows(renderList([post({ status: 'awaiting_approval' })]))[1]).toContain('承認待ち');
  });

  it('#69 状態列に「（区画で承認）」の補足を出す', () => {
    expect(rows(renderList([post({ status: 'awaiting_approval' })]))[1]).toContain('区画で承認');
  });

  it('#69 #approval-pending へのリンクがある', () => {
    expect(renderList([post({ status: 'awaiting_approval' })])).toContain(
      'href="#approval-pending"',
    );
  });

  it('#69 承認待ちの行には支度の Badge を出さない（publisher の無い provider でも）', () => {
    const text = textOf(
      renderList([post({ status: 'awaiting_approval', socialAccountId: NO_PUBLISHER_ACCOUNT_ID })]),
    );

    expect(text).not.toContain('配信 Plugin なし');
    expect(text).not.toContain('資格情報 未設定');
  });

  it('#69 対照：同じ条件の scheduled の行には支度の Badge が出る', () => {
    expect(
      textOf(renderList([post({ status: 'scheduled', socialAccountId: NO_PUBLISHER_ACCOUNT_ID })])),
    ).toContain('配信 Plugin なし');
  });

  it('#69 承認待ちの行には残り回数の補足を出さない', () => {
    expect(textOf(renderList([post({ status: 'awaiting_approval', skipCount: 2 })]))).not.toContain(
      '取りやめ',
    );
  });

  it('#69 承認待ちでない行に #approval-pending のリンクを出さない', () => {
    expect(renderList([post({ status: 'draft' })])).not.toContain('#approval-pending');
  });
});

describe('#69 投稿一覧の承認済みの予約', () => {
  it('#69 scheduled かつ approvedAt ありの行に「（承認済み）」を出す', () => {
    expect(
      rows(renderList([post({ status: 'scheduled', approvedAt: '2026-09-30T02:00:00.000Z' })]))[1],
    ).toContain('（承認済み）');
  });

  it('#69 approvedAt が null の予約には「承認済み」を出さない', () => {
    expect(textOf(renderList([post({ status: 'scheduled', approvedAt: null })]))).not.toContain(
      '承認済み',
    );
  });

  it('#69 approvedAt を渡さない（既存の行の形）予約にも「承認済み」を出さない', () => {
    expect(textOf(renderList([post({ status: 'scheduled' })]))).not.toContain('承認済み');
  });
});

// ---------------------------------------------------------------------------
// #70 投稿フォーム
// ---------------------------------------------------------------------------

const ACCOUNT: AccountOption = {
  id: ACCOUNT_ID,
  label: '公式（テストSNS）',
  manualSupported: true,
};

function renderForm(overrides: Partial<SocialPostFormProps> = {}): string {
  const props: SocialPostFormProps = {
    title: '投稿を作成',
    initial: {
      socialAccountId: ACCOUNT_ID,
      body: '',
      scheduledAtIso: null,
      status: 'draft',
      deliveryMode: 'auto',
    },
    accounts: [ACCOUNT],
    ...overrides,
  };
  return renderToStaticMarkup(createElement(SocialPostForm, props));
}

function renderEdit(initial: SocialPostFormProps['initial']): string {
  return renderForm({ title: '投稿を編集', initial, postId: POST_ID });
}

/** 状態の `<select name="status">` の選択肢（値と表示名）。 */
function statusOptions(html: string): { value: string; label: string }[] {
  const start = html.indexOf('name="status"');
  if (start === -1) return [];
  const section = html.slice(start, html.indexOf('</select>', start));
  return [...section.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(
    (match) => ({ value: match[1] ?? '', label: match[2] ?? '' }),
  );
}

describe('#70 投稿フォームの状態の選択肢と案内', () => {
  it('#70 新規の選択肢が「下書き」「承認待ち」「予約済み」の順', () => {
    expect(statusOptions(renderForm())).toEqual([
      { value: 'draft', label: '下書き' },
      { value: 'awaiting_approval', label: '承認待ち' },
      { value: 'scheduled', label: '予約済み' },
    ]);
  });

  it('#70 承認待ちの投稿の編集では「承認待ち」「下書き」だけ', () => {
    const options = statusOptions(
      renderEdit({
        socialAccountId: ACCOUNT_ID,
        body: '承認待ちの本文',
        scheduledAtIso: '2026-10-01T00:00:00.000Z',
        status: 'awaiting_approval',
        deliveryMode: 'auto',
      }),
    );

    expect(options.map((option) => option.value).sort()).toEqual(
      ['awaiting_approval', 'draft'].sort(),
    );
  });

  it('#70 承認待ちの投稿の編集では承認の案内を出す', () => {
    const text = textOf(
      renderEdit({
        socialAccountId: ACCOUNT_ID,
        body: '承認待ちの本文',
        scheduledAtIso: null,
        status: 'awaiting_approval',
        deliveryMode: 'auto',
      }),
    );

    expect(text).toContain('承認待ちの投稿です。');
    expect(text).toContain('承認してください');
  });

  it('#70 承認済みの予約の編集では承認が外れる注意を出す', () => {
    const text = textOf(
      renderEdit({
        socialAccountId: ACCOUNT_ID,
        body: '承認済みの本文',
        scheduledAtIso: '2026-10-01T00:00:00.000Z',
        status: 'scheduled',
        deliveryMode: 'auto',
        approvedAtIso: '2026-09-30T02:00:00.000Z',
      }),
    );

    expect(text).toContain('承認済みの投稿です。');
    expect(text).toContain('承認待ちに戻ります');
  });

  it('#70 承認を経ていない予約の編集には承認の注意を出さない', () => {
    const text = textOf(
      renderEdit({
        socialAccountId: ACCOUNT_ID,
        body: '予約の本文',
        scheduledAtIso: '2026-10-01T00:00:00.000Z',
        status: 'scheduled',
        deliveryMode: 'auto',
      }),
    );

    expect(text).not.toContain('承認済みの投稿です。');
    expect(text).not.toContain('承認待ちの投稿です。');
  });

  it('#70 予約の編集の選択肢に承認待ちが入る（予約を承認待ちへ戻せる）', () => {
    const options = statusOptions(
      renderEdit({
        socialAccountId: ACCOUNT_ID,
        body: '予約の本文',
        scheduledAtIso: '2026-10-01T00:00:00.000Z',
        status: 'scheduled',
        deliveryMode: 'auto',
      }),
    );

    expect(options.map((option) => option.value)).toContain('awaiting_approval');
  });
});
