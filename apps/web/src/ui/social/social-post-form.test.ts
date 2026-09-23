import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SocialPostForm, type AccountOption, type SocialPostFormProps } from './social-post-form';

/**
 * 投稿フォームの「配信方法」（035-social-publishing 設計 §7.4、受け入れ条件 #70）。
 *
 * 足す props（実装プラン T22）：
 *
 * ```ts
 * AccountOption に manualSupported: boolean          // その provider に manual を持つ publisher があるか
 * SocialPostFormValues に deliveryMode: 'auto' | 'manual'
 * ```
 *
 * **押しても 422 になる選択肢を出さない**（設計 §7.4）。`manual` を持つ publisher が
 * 無い provider では欄そのものを出さず、`auto` 固定にする。
 *
 * 既存の `Alert`「実際の配信は、連携プラグインが行います」は E2E が見ているので残す（#79）。
 */

const MANUAL_ACCOUNT: AccountOption = {
  id: '01900000-0000-7000-8000-0000000000a1',
  label: '公式（テストSNS）',
  manualSupported: true,
};

const AUTO_ONLY_ACCOUNT: AccountOption = {
  id: '01900000-0000-7000-8000-0000000000a2',
  label: '公式（X）',
  manualSupported: false,
};

function render(overrides: Partial<SocialPostFormProps> = {}): string {
  const props: SocialPostFormProps = {
    title: '投稿を作成',
    initial: {
      socialAccountId: MANUAL_ACCOUNT.id,
      body: '',
      scheduledAtIso: null,
      status: 'draft',
      deliveryMode: 'auto',
    },
    accounts: [MANUAL_ACCOUNT, AUTO_ONLY_ACCOUNT],
    ...overrides,
  };
  return renderToStaticMarkup(createElement(SocialPostForm, props));
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

describe('SocialPostForm の配信方法', () => {
  it('#70 manualSupported のアカウントを選んでいるとき「配信方法」を出す', () => {
    const html = render();

    expect(textOf(html)).toContain('配信方法');
    expect(html).toContain('name="deliveryMode"');
  });

  it('#70 選択肢は「自動」と「手動」', () => {
    const html = render();

    expect(html).toMatch(/<option[^>]*value="auto"[^>]*>自動<\/option>/);
    expect(html).toMatch(/<option[^>]*value="manual"[^>]*>手動<\/option>/);
  });

  it('#70 既定は「自動」', () => {
    expect(render()).toMatch(/<option[^>]*value="auto"[^>]*selected/);
  });

  it('#70 編集で manual の投稿は「手動」が選ばれている', () => {
    const html = render({
      initial: {
        socialAccountId: MANUAL_ACCOUNT.id,
        body: '手動で投稿する',
        scheduledAtIso: '2026-09-22T10:00:00.000Z',
        status: 'scheduled',
        deliveryMode: 'manual',
      },
      postId: '01900000-0000-7000-8000-0000000000b1',
    });

    expect(html).toMatch(/<option[^>]*value="manual"[^>]*selected/);
  });

  it('#70 「配信方法」は「状態」より上に置く', () => {
    const html = render();
    const deliveryMode = html.indexOf('name="deliveryMode"');
    const status = html.indexOf('name="status"');

    expect(deliveryMode).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(-1);
    expect(deliveryMode).toBeLessThan(status);
  });

  it('#70 manualSupported でないアカウントでは「配信方法」を出さない', () => {
    const html = render({
      initial: {
        socialAccountId: AUTO_ONLY_ACCOUNT.id,
        body: '',
        scheduledAtIso: null,
        status: 'draft',
        deliveryMode: 'auto',
      },
    });

    expect(textOf(html)).not.toContain('配信方法');
  });

  it('#70 欄が無いとき deliveryMode の入力要素も無い（送信 body に入らない）', () => {
    // FormData に入らなければ、API へは既定の `auto` で届く（設計 §6.1.1）。
    const html = render({
      initial: {
        socialAccountId: AUTO_ONLY_ACCOUNT.id,
        body: '',
        scheduledAtIso: null,
        status: 'draft',
        deliveryMode: 'auto',
      },
    });

    expect(html).not.toContain('name="deliveryMode"');
  });

  it('#70 manual に対応したアカウントが 1 つも無ければ欄を出さない', () => {
    const html = render({
      initial: {
        socialAccountId: AUTO_ONLY_ACCOUNT.id,
        body: '',
        scheduledAtIso: null,
        status: 'draft',
        deliveryMode: 'auto',
      },
      accounts: [AUTO_ONLY_ACCOUNT],
    });

    expect(textOf(html)).not.toContain('配信方法');
  });
});

describe('配信の説明（設計 §7.4）', () => {
  it('#70 既存の「実際の配信は、連携プラグインが行います」を残す', () => {
    // E2E（`social.spec.ts`）が見ている文言（#79）。
    expect(textOf(render())).toContain('実際の配信は、連携プラグインが行います');
  });

  it('#70 自動配信と手動投稿の違いを 1 文添える', () => {
    const text = textOf(render());

    expect(text).toContain('自動配信は予約日時に Torifune が行い');
    expect(text).toContain('手動投稿は予約日時を過ぎると');
  });
});

/**
 * 設計 §11 #21（裁定 #12-a の代償）。
 * **支度待ちの投稿を「いますぐ出す」には未来の日時を指定する。**
 *
 * 飛ばした履歴（`skip_count` / `next_attempt_at`）が戻るのは
 * **予約日時が未来へ変わったときだけ**である（設計 §5.1.1 / §6.2）。
 * 過去の日時のまま保存しても `next_attempt_at` が消えないので、
 * 支度待ちで後ろへ送られた投稿は最大 23 時間待たされる。
 *
 * **未来を条件にしないと 3 回上限の回避路が開く**（R-2）ので、この挙動は変えない。
 * 代わりに**画面で案内する**、と設計が決めた。案内が無いと、
 * 運用者は「予約日時を直したのに出ない」を原因不明のまま踏む。
 */
describe('§11 #21 いますぐ出したいときの案内', () => {
  it('§11 #21 「いますぐ出したいとき」の案内がフォームに出る', () => {
    expect(textOf(render())).toContain('いますぐ出したいとき');
  });

  it('§11 #21 案内が「数分後の日時」を指定するよう書いている', () => {
    // 「過去の日時＝いますぐ」ではない、が伝わる唯一の手がかり。
    expect(textOf(render())).toContain('数分後の日時');
  });

  it('§11 #21 案内は予約日時の欄と同じフォームの中に出る', () => {
    // 別の画面に書いても、日時を直している人の目には入らない。
    const html = render();

    expect(html).toContain('name="scheduledAt"');
    expect(textOf(html)).toContain('数分後の日時');
  });
});
