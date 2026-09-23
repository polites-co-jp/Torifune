import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SocialPosts, type PostRow, type SocialPostsProps } from './social-posts';

/**
 * SNS 投稿一覧の「配信方法」列と、配信の支度ができていない予約の警告
 * （035-social-publishing 設計 §7.3、受け入れ条件 #69）。
 *
 * 足す props（実装プラン T21）：
 *
 * ```ts
 * PostRow に deliveryMode / failureReason / attemptCount / externalUrl
 *
 * SocialPosts({
 *   …既存,
 *   // アカウント ID → そのアカウントの provider と資格情報の有無。
 *   accountProviders: Record<string, { provider: string; credentialConfigured: boolean }>;
 *   // provider → 登録された publisher（`publisherRegistry.listPublishers()` から組み立てる）。
 *   publisherProviders: Record<
 *     string,
 *     { label: string; manual: boolean; publish: boolean; credentialFieldKeys: readonly string[] }
 *   >;
 * })
 * ```
 *
 * **これは「予約を断らない」ことと対になっている**（要件 §4 裁定 #8、設計 §6.1.2）。
 * 配信 Plugin が無くても資格情報が未設定でも予約そのものは通すので、
 * 代わりに予約した時点で画面に出す。警告は 2 種類ある（2026-09-23 の改訂）。
 *
 * **既存の E2E（`social.spec.ts`）の locator を変えない**：見出し「投稿」、
 * 本文の抜粋、「編集」「削除」（#79）。
 */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000000a1';
const OTHER_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000a2';

const NO_PLUGIN_BADGE = '配信 Plugin なし';
const NO_CREDENTIAL_BADGE = '資格情報 未設定';

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: '01900000-0000-7000-8000-0000000000b1',
    socialAccountId: ACCOUNT_ID,
    body: '新製品のお知らせ',
    scheduledAt: '2026-09-22T10:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    externalUrl: null,
    // **2026-09-23 に足した（裁定 #15-a、受け入れ条件 #119）。** 飛ばされた回数（設計 §7.3）。
    skipCount: 0,
    ...overrides,
  };
}

const BASE: SocialPostsProps = {
  initialPosts: [post()],
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）', [OTHER_ACCOUNT_ID]: '公式（X）' },
  accountProviders: {
    [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true },
    [OTHER_ACCOUNT_ID]: { provider: 'x', credentialConfigured: false },
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

function render(overrides: Partial<SocialPostsProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialPosts, { ...BASE, ...overrides }));
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

describe('SocialPosts の配信方法', () => {
  it('#69 列見出しに「配信方法」がある', () => {
    expect(rows(render())[0]).toContain('配信方法');
  });

  it('#69 auto の行を「自動」と出す', () => {
    const body = rows(render())[1] ?? '';

    expect(body).toContain('自動');
  });

  it('#69 manual の行を「手動」と出す', () => {
    const body = rows(render({ initialPosts: [post({ deliveryMode: 'manual' })] }))[1] ?? '';

    expect(body).toContain('手動');
  });

  it('#69 既存の locator（見出し「投稿」・本文・編集・削除）を壊さない', () => {
    // `social.spec.ts` は変更しないこと自体が受け入れ条件（#79）。
    const html = render();
    const text = textOf(html);

    expect(html).toMatch(/<h2[^>]*>投稿<\/h2>/);
    expect(text).toContain('新製品のお知らせ');
    expect(text).toContain('編集');
    expect(text).toContain('削除');
  });
});

describe('配信の支度ができていない予約の警告', () => {
  it('#69 publisher の無い provider の予約に「配信 Plugin なし」を付ける', () => {
    const html = render({ initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID })] });

    expect(textOf(html)).toContain(NO_PLUGIN_BADGE);
  });

  it('#69 publisher があり資格情報も設定済みなら警告を付けない', () => {
    const text = textOf(render());

    expect(text).not.toContain(NO_PLUGIN_BADGE);
    expect(text).not.toContain(NO_CREDENTIAL_BADGE);
  });

  it('#69 publisher はあるが資格情報が未設定なら「資格情報 未設定」を付ける', () => {
    // 2026-09-23 の改訂（要件 §4 裁定 #8）。警告は 2 種類ある。
    const text = textOf(
      render({
        accountProviders: {
          ...BASE.accountProviders,
          [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: false },
        },
      }),
    );

    expect(text).toContain(NO_CREDENTIAL_BADGE);
  });

  it('#69 credentialFieldKeys が空の publisher では資格情報が未設定でも警告しない', () => {
    // 資格情報の要らない配信手段（設計 §5.7）。
    const text = textOf(
      render({
        accountProviders: {
          ...BASE.accountProviders,
          [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: false },
        },
        publisherProviders: {
          testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
        },
      }),
    );

    expect(text).not.toContain(NO_CREDENTIAL_BADGE);
  });

  it('#69 publish を持たない publisher は「配信 Plugin なし」扱い', () => {
    const text = textOf(
      render({
        publisherProviders: {
          testsns: {
            label: 'テストSNS',
            manual: true,
            publish: false,
            credentialFieldKeys: ['identifier'],
          },
        },
      }),
    );

    expect(text).toContain(NO_PLUGIN_BADGE);
  });

  it('#69 draft の行には警告を付けない', () => {
    // 予約していないものは配信されなくて当たり前。
    const text = textOf(
      render({
        initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID, status: 'draft' })],
      }),
    );

    expect(text).not.toContain(NO_PLUGIN_BADGE);
  });

  it('#69 manual の行には警告を付けない', () => {
    // 手動投稿はジョブを通らない（設計 §7.3 は auto の行だけを見る）。
    const text = textOf(
      render({
        initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID, deliveryMode: 'manual' })],
      }),
    );

    expect(text).not.toContain(NO_PLUGIN_BADGE);
  });

  it('#69 一覧の上に警告の Alert を件数つきで出す', () => {
    const text = textOf(
      render({
        initialPosts: [
          post({ socialAccountId: OTHER_ACCOUNT_ID }),
          post({ id: 'p2', socialAccountId: OTHER_ACCOUNT_ID }),
        ],
        total: 2,
      }),
    );

    expect(text).toMatch(/配信の支度ができていない予約投稿が\s*2\s*件あります/);
  });

  it('#69 Alert に「配信されません」の説明を添える', () => {
    const text = textOf(render({ initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID })] }));

    expect(text).toContain('配信されません');
  });

  it('#69 対象が無ければ Alert を出さない', () => {
    expect(textOf(render())).not.toContain('配信の支度ができていない予約投稿');
  });

  /**
   * #106（設計 §7.3、裁定 #9。2026-09-23 に足した）。
   *
   * 裁定 #9 で「支度が整わない予約は約24時間で `failed` になる」という
   * **新しい結末**が生まれた。画面がそれを言わないと、運用者は取りやめられて
   * 初めて知ることになる。**警告は「いつまでに直せばよいか」まで伝える。**
   *
   * 条件 #106 は (D) で画面の配線を見るが、文言そのものはここでも観測できる。
   */
  it('#106 Alert に約24時間で取りやめになることを書く', () => {
    const text = textOf(render({ initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID })] }));

    expect(text).toContain('約24時間');
  });

  it('#106 Alert に取りやめ（失敗）になると書く', () => {
    const text = textOf(render({ initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID })] }));

    expect(text).toMatch(/取りやめ|失敗/);
  });
});

describe('状態列の補足', () => {
  it('#69 scheduled で failureReason があれば「再試行待ち・2 回目」を出す', () => {
    // N は `attemptCount + 1`（設計 §7.3）。
    const text = textOf(
      render({
        initialPosts: [post({ failureReason: '受け手が 503 を返した', attemptCount: 1 })],
      }),
    );

    expect(text).toMatch(/再試行待ち・2\s*回目/);
  });

  it('#69 failureReason が無ければ再試行待ちと出さない', () => {
    expect(textOf(render())).not.toContain('再試行待ち');
  });

  it('#69 published で externalUrl があれば「投稿を見る」リンクを出す', () => {
    const html = render({
      initialPosts: [
        post({
          status: 'published',
          publishedAt: '2026-09-22T10:01:00.000Z',
          externalUrl: 'https://x.com/torifune/status/1',
        }),
      ],
    });

    expect(textOf(html)).toContain('投稿を見る');
    expect(html).toContain('href="https://x.com/torifune/status/1"');
  });

  it('#69 「投稿を見る」は rel="noopener noreferrer" の別タブで開く', () => {
    const html = render({
      initialPosts: [
        post({
          status: 'published',
          publishedAt: '2026-09-22T10:01:00.000Z',
          externalUrl: 'https://x.com/torifune/status/1',
        }),
      ],
    });

    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toContain('target="_blank"');
  });

  it('#69 externalUrl が無ければ「投稿を見る」を出さない', () => {
    const text = textOf(
      render({
        initialPosts: [post({ status: 'published', publishedAt: '2026-09-22T10:01:00.000Z' })],
      }),
    );

    expect(text).not.toContain('投稿を見る');
  });
});

/**
 * #119（2026-09-23 に足した。裁定 #15-a、設計 §7.3）。
 * **飛ばされた予約に「あと n 回で取りやめ」を出す。**
 *
 * 裁定 #14-a（予約し直しでは飛ばされた回数が減らない）の代償で、
 * 2 回飛ばされた投稿は**日時を直しても次の 1 回で `failed`** になる（設計 §11 #24）。
 * `failed` は終端なので予約に戻せない。**運用者が予約し直す前に残りを知れること**が
 * この補足の目的で、`Badge`（何が足りないか）とは別の問いに答える。
 *
 * 置き場所は状態列の補足で、既存の「再試行待ち・N 回目」「手動投稿待ち」に揃える。
 */
describe('#119 残り回数の補足', () => {
  /** `PUBLISH_MAX_SKIPS` は 3（設計 §5.6.2）。画面は `3 - skipCount` を出す。 */
  it('#119 skipCount: 1 の予約に「あと 2 回で取りやめ」を出す', () => {
    const text = textOf(render({ initialPosts: [post({ skipCount: 1 })] }));

    expect(text).toMatch(/支度待ち・あと\s*2\s*回で取りやめ/);
  });

  it('#119 skipCount: 2 の予約は「あと 1 回で取りやめ」', () => {
    const text = textOf(render({ initialPosts: [post({ skipCount: 2 })] }));

    expect(text).toMatch(/支度待ち・あと\s*1\s*回で取りやめ/);
  });

  it('#119 skipCount: 0 の予約には出さない', () => {
    // 飛ばされていない予約に残り回数は無い。
    expect(textOf(render())).not.toMatch(/支度待ち・あと/);
  });

  it('#119 manual の行には出さない', () => {
    // 手動投稿はジョブを通らないので飛ばされない（`Badge` と同じ）。
    const text = textOf(render({ initialPosts: [post({ deliveryMode: 'manual', skipCount: 2 })] }));

    expect(text).not.toMatch(/支度待ち・あと/);
  });

  it.each(['draft', 'published', 'failed'])('#119 %s の行には出さない', (status) => {
    // 予約していないもの・終端のものに残り回数は無い。
    // とくに `failed` は戻せないので、「あと 0 回」と書くと予約へ戻せるように読める。
    const text = textOf(render({ initialPosts: [post({ status, skipCount: 3 })] }));

    expect(text).not.toMatch(/支度待ち・あと/);
  });

  /**
   * **`Badge` とは出る条件が違う。** `Badge` は「いま支度が整っていないか」、
   * 補足は「これまでに何回飛ばされたか」。支度が整った直後の行は
   * `Badge` が消えても補足は残る（0 に戻るのは配信に着手できたとき）。
   */
  it('#119 支度が整っている（Badge が出ない）行でも skipCount > 0 なら出す', () => {
    const text = textOf(render({ initialPosts: [post({ skipCount: 1 })] }));

    expect(text).not.toContain(NO_PLUGIN_BADGE);
    expect(text).not.toContain(NO_CREDENTIAL_BADGE);
    expect(text).toMatch(/支度待ち・あと\s*2\s*回で取りやめ/);
  });

  it('#119 配信 Plugin なしの行では Badge と補足の両方が出る', () => {
    const text = textOf(
      render({ initialPosts: [post({ socialAccountId: OTHER_ACCOUNT_ID, skipCount: 2 })] }),
    );

    expect(text).toContain(NO_PLUGIN_BADGE);
    expect(text).toMatch(/支度待ち・あと\s*1\s*回で取りやめ/);
  });

  it('#119 再試行待ちの補足と同じ列に並ぶ', () => {
    // 状態列の中（設計 §7.3）。行の中に両方が出る。
    const body =
      rows(
        render({
          initialPosts: [
            post({ failureReason: '受け手が 503 を返した', attemptCount: 1, skipCount: 1 }),
          ],
        }),
      )[1] ?? '';

    expect(body).toMatch(/再試行待ち・2\s*回目/);
    expect(body).toMatch(/支度待ち・あと\s*2\s*回で取りやめ/);
  });

  it('#119 上限に達していれば「あと 0 回」より下がらない', () => {
    // 3 回目に達した投稿は `failed` になるので通常この行は出ないが、下限は 0。
    const text = textOf(render({ initialPosts: [post({ skipCount: 5 })] }));

    expect(text).toMatch(/支度待ち・あと\s*0\s*回で取りやめ/);
  });

  it('#119 既存の locator（見出し「投稿」・本文・編集・削除）を壊さない', () => {
    const html = render({ initialPosts: [post({ skipCount: 2 })] });
    const text = textOf(html);

    expect(html).toMatch(/<h2[^>]*>投稿<\/h2>/);
    expect(text).toContain('新製品のお知らせ');
    expect(text).toContain('編集');
    expect(text).toContain('削除');
  });
});
