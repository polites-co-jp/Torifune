import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { approveRequestBody } from './approval-request';

/**
 * 1 件の承認のダイアログ（055-social-pending-tab 設計 §9.3.4、受け入れ条件 #50）。
 *
 * 送信待ちの表の「承認する…」が開く `ApprovalDialog`（`ui/social/approval-dialog.tsx`）。今の承認のダイアログに、
 * 承認待ちの区画のカードが出していた内容（本文の全文・リンク・画像の URL と代替テキスト・依頼の日時と登録元・
 * 希望日時・支度の警告・手動投稿のみの注意）を上に足す。承認は内容を確かめる操作で、抜粋では判断できない（048 §7.1.2）。
 * **登録元は 054 の登録元の表示**（「管理画面」／トークンの名前〔失効・削除済み〕）で、区画の依頼の経路「API／画面」は出さない。
 *
 * `approval-pending.test.ts`（048 #65・#67・#68）の条件のうち、カードの内容（#65）・時機（#67）・
 * `approveRequestBody`（#68）をここへ移す（実装プラン §8 の 7・8）。区画の見出し・0 行で描かない・区画の `id`・
 * 依頼の経路「API」「画面」の件は移さない（設計 §14）。ボタンの出し分け（#66）は `social-pending.test.ts`（#46・#47）が見る。
 *
 * **props の形は設計が決めていない**（§9.3.4 は「`ApprovalDialog`」、#50 は「`initialApprovingId`」で開いた状態とだけ書く）。
 * 実装プラン T17 の「props は承認待ちの行（設計 §9.3.5 の `PendingRow` の承認に要る項目）」から、
 * **開いている行 `row`（閉じているときは `null`）・アカウントの表示名 `accountName`・`open`** を渡して描くと読んだ
 * （`initialApprovingId` は表を描く `SocialPending` が受け取り、その行をこの部品へ渡す。実装プラン §8 の 61）。
 * 閉じる・承認した後の呼び返しは押さないと呼ばれないので、名前に依らない（静的な描画では押せない）。
 * 部品はまだ無いので、指定子を `string` の定数に置いた動的 import で読み、props の型をテストに写して `as` で渡す
 * （053 実装プラン §8 の 44・054 実装プラン §8 の 43）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.3.5 から写す）                                                     */
/* -------------------------------------------------------------------------- */

type PostSourceView =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly label: string; readonly revoked: boolean }
  | { readonly kind: 'deleted_token'; readonly label: string };

interface DialogRow {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  /** 承認待ちでは希望日時。 */
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly deliveryMode: 'auto' | 'manual';
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly skipCount: number;
  readonly externalUrl: string | null;
  readonly updatedAt?: string;
  readonly source?: PostSourceView;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
  readonly kind: 'manual_pending' | 'awaiting_approval' | 'scheduled';
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

interface DialogProps {
  readonly row: DialogRow | null;
  readonly accountName: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onApproved: () => void;
}

const MODULE: string = '@/ui/social/approval-dialog';

async function loadDialog(): Promise<ComponentType<DialogProps>> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  const component = module['ApprovalDialog'];
  if (typeof component !== 'function') {
    throw new Error('ui/social/approval-dialog.tsx に ApprovalDialog が無い');
  }
  return component as ComponentType<DialogProps>;
}

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const POST_ID = '01900000-0000-7000-8000-0000000055c1';

function row(overrides: Partial<DialogRow> = {}): DialogRow {
  return {
    id: POST_ID,
    socialAccountId: '01900000-0000-7000-8000-0000000055a1',
    body: '新製品のお知らせです。\n詳しくはこちら。',
    scheduledAt: '2026-10-30T00:00:00.000Z',
    status: 'awaiting_approval',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    updatedAt: '2026-10-23T01:12:00.123Z',
    source: { kind: 'token', label: 'ブログ連携', revoked: false },
    desiredPast: false,
    manualOnly: false,
    kind: 'awaiting_approval',
    link: 'https://example.com/news/1',
    media: [{ url: 'https://cdn.example.com/a.jpg', alt: '製品の写真' }],
    requestedAt: '2026-10-23T01:12:00.000Z',
    warning: null,
    ...overrides,
  };
}

async function render(overrides: Partial<DialogRow> = {}): Promise<string> {
  const ApprovalDialog = await loadDialog();
  return renderToStaticMarkup(
    createElement(ApprovalDialog, {
      row: row(overrides),
      accountName: '公式（テストSNS）',
      open: true,
      onClose: vi.fn(),
      onApproved: vi.fn(),
    }),
  );
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

function anchorWithHref(html: string, href: string): string | undefined {
  return [...html.matchAll(/<a\b[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`href="${href}"`));
}

// ---------------------------------------------------------------------------
// #50 全文の確認（承認待ちの区画のカードの内容。048 #65 から移す）
// ---------------------------------------------------------------------------

describe('#50 ApprovalDialog の全文の確認', () => {
  it('#50 開くと「投稿を承認する」の見出しが出る', async () => {
    expect(textOf(await render())).toContain('投稿を承認する');
  });

  it('#50 本文の全文を出し、改行を保つ（white-space: pre-wrap）', async () => {
    const html = await render();

    expect(html).toContain('新製品のお知らせです。\n詳しくはこちら。');
    expect(html).toMatch(/white-space:\s*pre-wrap/);
  });

  it('#50 長い本文も抜粋しない', async () => {
    const long = `${'あ'.repeat(500)}末尾の文`;

    expect(textOf(await render({ body: long }))).toContain(long);
  });

  it('#50 リンクを別タブで開く a 要素にし、rel="noopener noreferrer" を付ける', async () => {
    const anchor = anchorWithHref(await render(), 'https://example.com/news/1');

    expect(anchor).toBeDefined();
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(anchor).toContain('target="_blank"');
  });

  it('#50 画像は URL と代替テキストを出し、<img> を描かない', async () => {
    const html = await render();

    expect(textOf(html)).toContain('https://cdn.example.com/a.jpg');
    expect(textOf(html)).toContain('製品の写真');
    expect(html).not.toContain('<img');
  });

  it('#50 画像の URL も rel="noopener noreferrer" のリンクにする', async () => {
    expect(anchorWithHref(await render(), 'https://cdn.example.com/a.jpg')).toContain(
      'rel="noopener noreferrer"',
    );
  });

  it('#50 アカウント名と配信方法（自動／手動）を出す', async () => {
    expect(textOf(await render())).toContain('公式（テストSNS）');
    expect(textOf(await render())).toContain('自動');
    expect(textOf(await render({ deliveryMode: 'manual' }))).toContain('手動');
  });

  it('#50 依頼の日時の見出し「依頼」を出す', async () => {
    expect(textOf(await render())).toContain('依頼');
  });

  it('#50 登録元：トークンの名前を出す', async () => {
    expect(textOf(await render())).toContain('ブログ連携');
  });

  it('#50 登録元：画面の登録は「管理画面」', async () => {
    expect(textOf(await render({ source: { kind: 'screen' } }))).toContain('管理画面');
  });

  it('#50 登録元：失効したトークンは名前と「（失効）」', async () => {
    const text = textOf(
      await render({ source: { kind: 'token', label: 'ショップ連携', revoked: true } }),
    );

    expect(text).toContain('ショップ連携');
    expect(text).toContain('（失効）');
  });

  it('#50 登録元：行が消えたトークンは名前と「（削除済み）」', async () => {
    const text = textOf(await render({ source: { kind: 'deleted_token', label: '旧連携' } }));

    expect(text).toContain('旧連携');
    expect(text).toContain('（削除済み）');
  });

  it('#50 依頼の経路「API」は出さない（054 の登録元に置き換えた。設計 §9.3.4）', async () => {
    expect(textOf(await render())).not.toContain('API');
  });

  it('#50 希望日時の見出しを出す', async () => {
    expect(textOf(await render())).toContain('希望日時');
  });

  it('#50 希望日時が無ければ「—」', async () => {
    expect(textOf(await render({ scheduledAt: null }))).toContain('—');
  });

  it('#50 希望日時が過ぎていれば「（過ぎています）」を添える', async () => {
    expect(textOf(await render({ desiredPast: true }))).toContain('（過ぎています）');
  });

  it('#50 希望日時が過ぎていなければ「（過ぎています）」を出さない', async () => {
    expect(textOf(await render())).not.toContain('（過ぎています）');
  });

  it('#50 manualOnly の行に手動投稿のみの注意を出す', async () => {
    expect(textOf(await render({ manualOnly: true }))).toContain('この SNS は手動投稿のみのため');
  });

  it('#50 manualOnly でない行には注意を出さない', async () => {
    expect(textOf(await render())).not.toContain('この SNS は手動投稿のみのため');
  });

  it('#50 warning: no_publisher なら「配信 Plugin なし」の Badge', async () => {
    expect(textOf(await render({ warning: 'no_publisher' }))).toContain('配信 Plugin なし');
  });

  it('#50 warning: credential_missing なら「資格情報 未設定」の Badge', async () => {
    expect(textOf(await render({ warning: 'credential_missing' }))).toContain('資格情報 未設定');
  });

  it('#50 承認待ちの手動投稿のダイアログに「投稿画面を開く」を出さない（承認を経ずに出さない）', async () => {
    expect(textOf(await render({ deliveryMode: 'manual' }))).not.toContain('投稿画面を開く');
  });

  it('#50 閉じている（row: null・open: false）なら何も出さない', async () => {
    const ApprovalDialog = await loadDialog();
    const html = renderToStaticMarkup(
      createElement(ApprovalDialog, {
        row: null,
        accountName: '公式（テストSNS）',
        open: false,
        onClose: vi.fn(),
        onApproved: vi.fn(),
      }),
    );

    expect(textOf(html)).not.toContain('投稿を承認する');
  });
});

// ---------------------------------------------------------------------------
// #50 時機（048 #67 から移す。今の承認のダイアログの単体テストの条件のまま）
// ---------------------------------------------------------------------------

describe('#50 承認の時機（048 #67 のまま）', () => {
  it('#50 manualOnly の行は「即投稿」だけで「指定の時間に投稿」を出さない', async () => {
    const html = await render({ manualOnly: true });

    expect(textOf(html)).toContain('即投稿');
    expect(textOf(html)).not.toContain('指定の時間に投稿');
    expect(radios(html).map((radio) => radio.value)).not.toContain('scheduled');
  });

  it('#50 それ以外は「即投稿」と「指定の時間に投稿」の 2 択', async () => {
    const html = await render();

    expect(textOf(html)).toContain('即投稿');
    expect(textOf(html)).toContain('指定の時間に投稿');
    expect(
      radios(html)
        .map((radio) => radio.value)
        .sort(),
    ).toEqual(['now', 'scheduled']);
  });

  it('#50 希望日時が未来なら「指定の時間に投稿」が既定', async () => {
    const checked = radios(await render()).filter((radio) => radio.checked);

    expect(checked.map((radio) => radio.value)).toEqual(['scheduled']);
  });

  it('#50 希望日時が過ぎていれば「即投稿」が既定で、警告を出す', async () => {
    const html = await render({ desiredPast: true });

    expect(
      radios(html)
        .filter((radio) => radio.checked)
        .map((radio) => radio.value),
    ).toEqual(['now']);
    expect(textOf(html)).toContain(
      '希望日時を過ぎています。即投稿を選ぶか、日時を指定し直してください。',
    );
  });

  it('#50 希望日時が無ければ「即投稿」が既定で、過ぎた警告は出さない', async () => {
    const html = await render({ scheduledAt: null });

    expect(
      radios(html)
        .filter((radio) => radio.checked)
        .map((radio) => radio.value),
    ).toEqual(['now']);
    expect(textOf(html)).not.toContain('希望日時を過ぎています。即投稿を選ぶか');
  });

  it('#50 希望日時が未来なら過ぎた警告を出さない', async () => {
    expect(textOf(await render())).not.toContain('希望日時を過ぎています。即投稿を選ぶか');
  });

  it('#50 日時の欄は datetime-local で、「即投稿」が既定のときは disabled', async () => {
    const input = [...(await render({ desiredPast: true })).matchAll(/<input\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes('type="datetime-local"'));

    expect(input).toBeDefined();
    expect(input).toMatch(/\sdisabled(=""|\s|>|\/)/);
  });

  it('#50 「指定の時間に投稿」が既定のときは日時の欄が使える', async () => {
    const input = [...(await render()).matchAll(/<input\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes('type="datetime-local"'));

    expect(input).toBeDefined();
    expect(input).not.toMatch(/\sdisabled(=""|\s|>|\/)/);
  });
});

// ---------------------------------------------------------------------------
// #50 approveRequestBody（048 #68 から移す。approval-request.ts）
// ---------------------------------------------------------------------------

describe('#50 approveRequestBody（048 #68 のまま）', () => {
  const UPDATED_AT = '2026-10-23T01:12:00.123Z';

  it("#50 now → { publishTiming: 'now', expectedUpdatedAt }（scheduledAt を含まない）", () => {
    const body = approveRequestBody({
      timing: 'now',
      scheduledAtLocal: '2026-10-30T09:00',
      updatedAt: UPDATED_AT,
    });

    expect(body).toEqual({ publishTiming: 'now', expectedUpdatedAt: UPDATED_AT });
    expect(Object.keys(body)).not.toContain('scheduledAt');
  });

  it('#50 scheduled → ローカルの日時を ISO にした scheduledAt を含む', () => {
    const local = '2026-10-30T09:00';

    expect(
      approveRequestBody({ timing: 'scheduled', scheduledAtLocal: local, updatedAt: UPDATED_AT }),
    ).toEqual({
      publishTiming: 'scheduled',
      expectedUpdatedAt: UPDATED_AT,
      scheduledAt: new Date(local).toISOString(),
    });
  });
});
