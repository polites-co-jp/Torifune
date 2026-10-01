import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalPending,
  type ApprovalPendingProps,
  type ApprovalPendingRow,
} from './approval-pending';
import { approveRequestBody } from './approval-request';

/**
 * 「承認待ち」区画（048-social-post-approval 設計 §7.1・§7.2・§7.6、受け入れ条件 #65〜#68）。
 *
 * 想定する props（設計 §7.1.1。Server Component が `listApprovalPendingPosts({ limit: 50 })` から組み立てる）：
 *
 * ```ts
 * ApprovalPending({
 *   rows: ApprovalPendingRow[];   // 設計 §7.1.1 の形（「いま」は Server が見て desiredPast に入れる）
 *   total: number;                // 見出しの件数（51 件目以降は区画に出ないが、見出しで溢れが分かる。§7.1.1）
 *   canApprove: boolean;          // social.approve を持つか（表示制御）
 *   canWrite: boolean;            // social.write を持つか（表示制御）
 *   initialApprovingId?: string;  // テストのための口（承認のダイアログを開いた状態で描く。実装プラン §8 の 12）
 * })
 * ```
 *
 * * 見出しの件数の props 名は設計が決めていない。`listApprovalPendingPosts` の戻り値（`{ items, total }`）に合わせて
 *   **`total`** と読んだ
 * * ダイアログの選択肢はラジオで、値は承認の要求と同じ **`now` / `scheduled`** と読んだ（設計 §7.1.3・§6.4.1）
 * * 日時の表示形式は設計が決めていないので、文字列そのものは見ない（経路・希望日時の有無・過ぎた印だけを見る）
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const POST_ID = '01900000-0000-7000-8000-0000000000c1';
const OTHER_ID = '01900000-0000-7000-8000-0000000000c2';

function row(overrides: Partial<ApprovalPendingRow> = {}): ApprovalPendingRow {
  return {
    id: POST_ID,
    accountName: '公式（テストSNS）',
    deliveryMode: 'auto',
    body: '新製品のお知らせです。\n詳しくはこちら。',
    link: 'https://example.com/news/1',
    media: [{ url: 'https://cdn.example.com/a.jpg', alt: '製品の写真' }],
    requestedAt: '2026-09-30T01:12:00.000Z',
    viaApi: true,
    desiredScheduledAt: '2026-10-01T00:00:00.000Z',
    desiredPast: false,
    manualOnly: false,
    updatedAt: '2026-09-30T01:12:00.123Z',
    warning: null,
    ...overrides,
  };
}

function render(overrides: Partial<ApprovalPendingProps> = {}): string {
  const props: ApprovalPendingProps = {
    rows: [row()],
    total: 1,
    canApprove: true,
    canWrite: true,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ApprovalPending, props));
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

/** `<button>` の文字。 */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    textOf(match[1] ?? '').trim(),
  );
}

/** ラジオの値と選ばれているか。 */
function radios(html: string): { value: string; checked: boolean }[] {
  return [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /type="radio"/.test(tag))
    .map((tag) => ({
      value: /value="([^"]*)"/.exec(tag)?.[1] ?? '',
      checked: /\schecked(=""|\s|>|\/)/.test(tag),
    }));
}

// ---------------------------------------------------------------------------
// #65 区画の表示
// ---------------------------------------------------------------------------

describe('#65 ApprovalPending の表示', () => {
  it('#65 0 行なら何も描かない', () => {
    expect(render({ rows: [], total: 0 })).toBe('');
  });

  it('#65 見出しに「承認待ち」と件数（total）を出す', () => {
    const text = textOf(render({ rows: [row(), row({ id: OTHER_ID })], total: 2 }));

    expect(text).toMatch(/承認待ち（\s*2\s*件）/);
  });

  it('#65 見出しの件数は total（51 件目以降は区画に出ないが件数で分かる）', () => {
    expect(textOf(render({ rows: [row()], total: 51 }))).toMatch(/承認待ち（\s*51\s*件）/);
  });

  it('#65 区画にアンカー approval-pending がある', () => {
    expect(render()).toContain('id="approval-pending"');
  });

  it('#65 案内の文を出す', () => {
    expect(textOf(render())).toContain('外部アプリなどから確認を求められている投稿です。');
  });

  it('#65 本文の全文を出し、改行を保つ（white-space: pre-wrap）', () => {
    const html = render();

    expect(html).toContain('新製品のお知らせです。\n詳しくはこちら。');
    expect(html).toMatch(/white-space:\s*pre-wrap/);
  });

  it('#65 長い本文も抜粋しない', () => {
    const long = `${'あ'.repeat(500)}末尾の文`;

    expect(textOf(render({ rows: [row({ body: long })] }))).toContain(long);
  });

  it('#65 リンクを別タブで開く a 要素にし、rel="noopener noreferrer" を付ける', () => {
    const anchor = [...render().matchAll(/<a\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes('href="https://example.com/news/1"'));

    expect(anchor).toBeDefined();
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(anchor).toContain('target="_blank"');
  });

  it('#65 画像は URL と代替テキストを出し、<img> を描かない', () => {
    const html = render();

    expect(textOf(html)).toContain('https://cdn.example.com/a.jpg');
    expect(textOf(html)).toContain('製品の写真');
    expect(html).not.toContain('<img');
  });

  it('#65 画像の URL も rel="noopener noreferrer" のリンクにする', () => {
    const anchor = [...render().matchAll(/<a\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes('href="https://cdn.example.com/a.jpg"'));

    expect(anchor).toContain('rel="noopener noreferrer"');
  });

  it('#65 アカウント名と配信方法（自動／手動）を出す', () => {
    expect(textOf(render())).toContain('公式（テストSNS）');
    expect(textOf(render())).toContain('自動');
    expect(textOf(render({ rows: [row({ deliveryMode: 'manual' })] }))).toContain('手動');
  });

  it('#65 依頼の経路が API なら「API」を出す', () => {
    expect(textOf(render({ rows: [row({ viaApi: true })] }))).toContain('API');
  });

  it('#65 依頼の経路が画面なら「画面」を出し「API」を出さない', () => {
    const text = textOf(render({ rows: [row({ viaApi: false })] }));

    expect(text).toContain('画面');
    expect(text).not.toContain('API');
  });

  it('#65 依頼の日時と希望日時の見出しを出す', () => {
    const text = textOf(render());

    expect(text).toContain('依頼');
    expect(text).toContain('希望日時');
  });

  it('#65 希望日時が無ければ「—」', () => {
    expect(textOf(render({ rows: [row({ desiredScheduledAt: null })] }))).toContain('—');
  });

  it('#65 希望日時が過ぎていれば「（過ぎています）」を添える', () => {
    expect(textOf(render({ rows: [row({ desiredPast: true })] }))).toContain('（過ぎています）');
  });

  it('#65 希望日時が過ぎていなければ「（過ぎています）」を出さない', () => {
    expect(textOf(render())).not.toContain('（過ぎています）');
  });

  it('#65 manualOnly の行に手動投稿のみの注意を出す', () => {
    expect(textOf(render({ rows: [row({ manualOnly: true })] }))).toContain(
      'この SNS は手動投稿のみのため',
    );
  });

  it('#65 manualOnly でない行には注意を出さない', () => {
    expect(textOf(render())).not.toContain('この SNS は手動投稿のみのため');
  });

  it('#65 warning: no_publisher なら「配信 Plugin なし」の Badge', () => {
    expect(textOf(render({ rows: [row({ warning: 'no_publisher' })] }))).toContain(
      '配信 Plugin なし',
    );
  });

  it('#65 warning: credential_missing なら「資格情報 未設定」の Badge', () => {
    expect(textOf(render({ rows: [row({ warning: 'credential_missing' })] }))).toContain(
      '資格情報 未設定',
    );
  });

  it('#65 承認待ちの手動投稿に「投稿画面を開く」を出さない（設計 §7.2）', () => {
    expect(textOf(render({ rows: [row({ deliveryMode: 'manual' })] }))).not.toContain(
      '投稿画面を開く',
    );
  });
});

// ---------------------------------------------------------------------------
// #66 ボタンの出し分け
// ---------------------------------------------------------------------------

describe('#66 canApprove / canWrite によるボタンの出し分け', () => {
  it('#66 両方あれば「承認する」「差し戻す」と編集のリンクがある', () => {
    const html = render();
    const labels = buttonLabels(html);

    expect(labels.some((label) => label.startsWith('承認する'))).toBe(true);
    expect(labels).toContain('差し戻す');
    expect(html).toContain(`href="/social/posts/${POST_ID}/edit"`);
  });

  it('#66 canApprove: false なら「承認する」が無い', () => {
    const labels = buttonLabels(render({ canApprove: false }));

    expect(labels.some((label) => label.startsWith('承認する'))).toBe(false);
  });

  it('#66 canApprove: false でも canWrite なら「差し戻す」は残る', () => {
    expect(buttonLabels(render({ canApprove: false }))).toContain('差し戻す');
  });

  it('#66 canWrite: false なら「差し戻す」が無い', () => {
    expect(buttonLabels(render({ canWrite: false }))).not.toContain('差し戻す');
  });

  it('#66 canWrite: false なら編集のリンクが無い', () => {
    expect(render({ canWrite: false })).not.toContain(`/social/posts/${POST_ID}/edit`);
  });

  it('#66 canWrite: false でも canApprove なら「承認する」は残る', () => {
    const labels = buttonLabels(render({ canWrite: false }));

    expect(labels.some((label) => label.startsWith('承認する'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #67 承認のダイアログ
// ---------------------------------------------------------------------------

describe('#67 承認のダイアログ', () => {
  function dialog(overrides: Partial<ApprovalPendingRow> = {}): string {
    return render({ rows: [row(overrides)], initialApprovingId: POST_ID });
  }

  it('#67 開くと「投稿を承認する」の見出しが出る', () => {
    expect(textOf(dialog())).toContain('投稿を承認する');
  });

  it('#67 manualOnly の行は「即投稿」だけで「指定の時間に投稿」を出さない', () => {
    const html = dialog({ manualOnly: true });

    expect(textOf(html)).toContain('即投稿');
    expect(textOf(html)).not.toContain('指定の時間に投稿');
    expect(radios(html).map((radio) => radio.value)).not.toContain('scheduled');
  });

  it('#67 manualOnly の行のダイアログに手動投稿のみの注意がある', () => {
    expect(textOf(dialog({ manualOnly: true }))).toContain('この SNS は手動投稿のみのため');
  });

  it('#67 それ以外は「即投稿」と「指定の時間に投稿」の 2 択', () => {
    const html = dialog();

    expect(textOf(html)).toContain('即投稿');
    expect(textOf(html)).toContain('指定の時間に投稿');
    expect(
      radios(html)
        .map((radio) => radio.value)
        .sort(),
    ).toEqual(['now', 'scheduled']);
  });

  it('#67 希望日時が未来なら「指定の時間に投稿」が既定', () => {
    const checked = radios(dialog()).filter((radio) => radio.checked);

    expect(checked.map((radio) => radio.value)).toEqual(['scheduled']);
  });

  it('#67 希望日時が過ぎていれば「即投稿」が既定で、警告を出す', () => {
    const html = dialog({ desiredPast: true });

    expect(
      radios(html)
        .filter((radio) => radio.checked)
        .map((radio) => radio.value),
    ).toEqual(['now']);
    expect(textOf(html)).toContain(
      '希望日時を過ぎています。即投稿を選ぶか、日時を指定し直してください。',
    );
  });

  it('#67 希望日時が無ければ「即投稿」が既定で、過ぎた警告は出さない', () => {
    const html = dialog({ desiredScheduledAt: null });

    expect(
      radios(html)
        .filter((radio) => radio.checked)
        .map((radio) => radio.value),
    ).toEqual(['now']);
    expect(textOf(html)).not.toContain('希望日時を過ぎています');
  });

  it('#67 希望日時が未来なら過ぎた警告を出さない', () => {
    expect(textOf(dialog())).not.toContain('希望日時を過ぎています');
  });

  it('#67 日時の欄は datetime-local で、「即投稿」が既定のときは disabled', () => {
    const input = [...dialog({ desiredPast: true }).matchAll(/<input\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes('type="datetime-local"'));

    expect(input).toBeDefined();
    expect(input).toMatch(/\sdisabled(=""|\s|>|\/)/);
  });

  it('#67 「指定の時間に投稿」が既定のときは日時の欄が使える', () => {
    const input = [...dialog().matchAll(/<input\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes('type="datetime-local"'));

    expect(input).toBeDefined();
    expect(input).not.toMatch(/\sdisabled(=""|\s|>|\/)/);
  });

  it('#67 initialApprovingId が無ければダイアログは閉じている', () => {
    expect(textOf(render())).not.toContain('投稿を承認する');
  });
});

// ---------------------------------------------------------------------------
// #68 approveRequestBody
// ---------------------------------------------------------------------------

describe('#68 approveRequestBody', () => {
  const UPDATED_AT = '2026-09-30T01:12:00.123Z';

  it("#68 now → { publishTiming: 'now', expectedUpdatedAt }（scheduledAt を含まない）", () => {
    const body = approveRequestBody({
      timing: 'now',
      scheduledAtLocal: '2026-10-01T09:00',
      updatedAt: UPDATED_AT,
    });

    expect(body).toEqual({ publishTiming: 'now', expectedUpdatedAt: UPDATED_AT });
    expect(Object.keys(body)).not.toContain('scheduledAt');
  });

  it('#68 scheduled → ローカルの日時を ISO にした scheduledAt を含む', () => {
    const local = '2026-10-01T09:00';

    expect(
      approveRequestBody({ timing: 'scheduled', scheduledAtLocal: local, updatedAt: UPDATED_AT }),
    ).toEqual({
      publishTiming: 'scheduled',
      expectedUpdatedAt: UPDATED_AT,
      scheduledAt: new Date(local).toISOString(),
    });
  });
});
