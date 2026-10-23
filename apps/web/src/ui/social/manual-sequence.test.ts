import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonProps } from '@/ui/components';

/**
 * 選んだ手動投稿を順に投稿のダイアログ（055-social-pending-tab 設計 §9.5.2、受け入れ条件 #55〜#57）。
 *
 * * #55 `initialIndex: 1`・対象 3 件：見出し「手動投稿（2 / 3 件目）」・2 件目の本文の全文・「投稿画面を開く」
 *   「投稿した」「投稿しなかった」「やめる」。**描画しただけでは `open` が呼ばれない**（開くのは人のクリックだけ）
 * * #56 `initialConfirming: true`：失敗として確定する確認の文言と「戻る」「失敗にする」
 * * #57 `initialIndex` が対象の件数・`initialRecords` に投稿した 2・投稿しなかった 1：終わりの表示と「閉じる」
 *
 * 押す操作は、`@/ui/components` の `Button` を包んで捕まえた `onClick` を直接呼び、外への作用（`open`・`apiRequest`）を見る。
 * 描画の後の `setState` は何もしないので、「次の件へ進む」は `initialIndex` / `initialRecords` / `initialConfirming` の
 * 描画で見る（実装プラン §8 の 20）。409 の文言・飛ばして次へ・閉じたときの Toast は画面（E2E #66・#67）で見る。
 *
 * **props の形は設計が決めていない**（§9.5.2 はテストの口 `initialIndex`・`initialRecords`・`initialConfirming`・`open`
 * だけを書く）。対象と対象外は `manualSequencePlanOf` の出力をそのまま `plan`、アカウントの表示名を `accountNames`、
 * 記録を `{ id, outcome: 'posted' | 'not_posted' | 'skipped' }` の並びと読んだ。部品は開いている間だけ描かれる
 * （`SocialPending` が始めたときに描く）ので、開いているかの props は持たない（実装プラン §8 の 63）。
 * 閉じたときの呼び返しは押さないと呼ばれないので、名前に依らない。
 * 部品はまだ無いので、指定子を `string` の定数に置いた動的 import で読み、props の型をテストに写して `as` で渡す。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const capture = vi.hoisted(() => ({ buttons: [] as unknown[], apiRequest: vi.fn() }));

vi.mock('@/ui/client/api-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/client/api-client');
  return { ...actual, apiRequest: capture.apiRequest };
});

vi.mock('@/ui/components', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/components');
  const Button = actual['Button'] as (props: ButtonProps) => ReactNode;
  return {
    ...actual,
    Button: (props: ButtonProps) => {
      capture.buttons.push(props);
      return Button(props);
    },
  };
});

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.3.5・§9.5・§9.12 から写す）                                          */
/* -------------------------------------------------------------------------- */

type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled';
    };

interface PendingRow {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly deliveryMode: 'auto' | 'manual';
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly skipCount: number;
  readonly externalUrl: string | null;
  readonly updatedAt?: string;
  readonly kind: 'manual_pending' | 'awaiting_approval' | 'scheduled';
  readonly elapsedText?: string;
  readonly handoff?: ManualHandoffOutcome;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

interface SequenceRecord {
  readonly id: string;
  readonly outcome: 'posted' | 'not_posted' | 'skipped';
}

interface SequenceProps {
  readonly plan: {
    readonly targets: readonly PendingRow[];
    readonly excluded: readonly {
      readonly reason: 'awaiting_approval' | 'handoff_unavailable' | 'auto';
      readonly count: number;
    }[];
  };
  readonly accountNames: Readonly<Record<string, string>>;
  readonly onClose: () => void;
  readonly open?: (url: string, name: string, features: string) => unknown;
  readonly initialIndex?: number;
  readonly initialRecords?: readonly SequenceRecord[];
  readonly initialConfirming?: boolean;
}

const MODULE: string = '@/ui/social/manual-sequence';

async function loadComponent(): Promise<ComponentType<SequenceProps>> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  const component = module['ManualSequence'];
  if (typeof component !== 'function') {
    throw new Error('ui/social/manual-sequence.tsx に ManualSequence が無い');
  }
  return component as ComponentType<SequenceProps>;
}

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000055a1';
const WINDOW_NAME = 'torifune-manual-post';
const WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';

function target(index: number, overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: `01900000-0000-7000-8000-0000005500${String(index).padStart(2, '0')}`,
    socialAccountId: ACCOUNT_ID,
    body: `${index} 件目の手動投稿の本文です。`,
    scheduledAt: '2026-10-24T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'manual',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    updatedAt: `2026-10-23T00:00:0${index}.123Z`,
    kind: 'scheduled',
    handoff: { ok: true, url: `https://example.com/intent?text=${index}`, note: null },
    link: null,
    media: [],
    requestedAt: '2026-10-23T00:00:00.000Z',
    warning: null,
    ...overrides,
  };
}

const LONG_BODY = `${'新製品のお知らせです。'.repeat(30)}最後まで全文を出す`;

const TARGETS: readonly PendingRow[] = [
  target(1),
  target(2, {
    body: LONG_BODY,
    handoff: {
      ok: true,
      url: 'https://example.com/intent?text=2',
      note: '画像は投稿画面で添付してください',
    },
  }),
  target(3),
];

const PLAN: SequenceProps['plan'] = {
  targets: TARGETS,
  excluded: [{ reason: 'awaiting_approval', count: 1 }],
};

async function render(overrides: Partial<SequenceProps> = {}): Promise<string> {
  const ManualSequence = await loadComponent();
  return renderToStaticMarkup(
    createElement(ManualSequence, {
      plan: PLAN,
      accountNames: { [ACCOUNT_ID]: 'X（@torifune）' },
      onClose: vi.fn(),
      ...overrides,
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

function buttonTexts(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    textOf(match[1] ?? '').trim(),
  );
}

function textOfNode(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props === undefined ? '' : textOfNode(props.children);
}

function recordedButton(
  label: string,
): { readonly onClick?: (event: unknown) => unknown } | undefined {
  const found = (capture.buttons as { children?: ReactNode; onClick?: unknown }[]).find(
    (props) => textOfNode(props.children).trim() === label,
  );
  return found === undefined
    ? undefined
    : typeof found.onClick === 'function'
      ? { onClick: found.onClick as (event: unknown) => unknown }
      : {};
}

const clickEvent = { preventDefault: () => {}, stopPropagation: () => {} };

beforeEach(() => {
  capture.buttons.length = 0;
  capture.apiRequest.mockReset();
  capture.apiRequest.mockResolvedValue({ ok: true, data: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* #55 2 / 3 件目                                                                */
/* -------------------------------------------------------------------------- */

describe('#55 ManualSequence（initialIndex: 1、対象 3 件）', () => {
  it('#55 見出しが「手動投稿（2 / 3 件目）」', async () => {
    expect(textOf(await render({ initialIndex: 1 }))).toContain('手動投稿（2 / 3 件目）');
  });

  it('#55 2 件目の本文の全文を出す（抜粋しない）', async () => {
    expect(textOf(await render({ initialIndex: 1 }))).toContain(LONG_BODY);
  });

  it('#55 1 件目・3 件目の本文は出さない（今の件だけ）', async () => {
    const text = textOf(await render({ initialIndex: 1 }));

    expect(text).not.toContain(TARGETS[0]?.body);
    expect(text).not.toContain(TARGETS[2]?.body);
  });

  it('#55 本文は overflow-wrap: anywhere（長い本文・URL でもダイアログの幅に収まる）', async () => {
    expect(await render({ initialIndex: 1 })).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('#55 アカウントの表示名を出す', async () => {
    expect(textOf(await render({ initialIndex: 1 }))).toContain('X（@torifune）');
  });

  it('#55 note（Plugin の補足）があれば本文の下に出す', async () => {
    const text = textOf(await render({ initialIndex: 1 }));

    expect(text).toContain('画像は投稿画面で添付してください');
    expect(text.indexOf('画像は投稿画面で添付してください')).toBeGreaterThan(
      text.indexOf('最後まで全文を出す'),
    );
  });

  it('#55 「投稿画面を開く」「投稿した」「投稿しなかった」「やめる」のボタンがある', async () => {
    const labels = buttonTexts(await render({ initialIndex: 1 }));

    for (const label of ['投稿画面を開く', '投稿した', '投稿しなかった', 'やめる']) {
      expect(labels, label).toContain(label);
    }
  });

  it('#55 開けないときの「別のタブで開く」リンク（同じ URL・rel="noopener noreferrer"）', async () => {
    const html = await render({ initialIndex: 1 });
    const anchor = [...html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/g)].find(
      (match) => textOf(match[2] as string).trim() === '別のタブで開く',
    );

    expect(anchor, '「別のタブで開く」').toBeDefined();
    expect(anchor?.[1]).toContain('href="https://example.com/intent?text=2"');
    expect(anchor?.[1]).toContain('rel="noopener noreferrer"');
  });

  it('#55 対象外の件数を出す（対象外 1 件・承認待ち）', async () => {
    const text = textOf(await render({ initialIndex: 1 }));

    expect(text).toMatch(/対象外\s*1\s*件/);
    expect(text).toContain('承認待ち');
  });

  it('#55 描画しただけでは open が呼ばれない（開くのは人のクリックだけ）', async () => {
    const open = vi.fn();
    await render({ initialIndex: 1, open });

    expect(open).not.toHaveBeenCalled();
  });

  it('#55 initialIndex を渡さなければ 1 件目（「手動投稿（1 / 3 件目）」）で、それでも open は呼ばれない', async () => {
    const open = vi.fn();
    const text = textOf(await render({ open }));

    expect(text).toContain('手動投稿（1 / 3 件目）');
    expect(open).not.toHaveBeenCalled();
  });

  it('#55 「投稿画面を開く」の onClick で、今の件の URL を (url, 窓の名前, 開き方) で 1 回開く', async () => {
    const open = vi.fn();
    await render({ initialIndex: 1, open });

    recordedButton('投稿画面を開く')?.onClick?.(clickEvent);

    expect(open.mock.calls).toEqual([
      ['https://example.com/intent?text=2', WINDOW_NAME, WINDOW_FEATURES],
    ]);
  });

  it('#55 「投稿した」の onClick で manual-outcome に posted と今の件の updatedAt を送る（URL が空なら externalUrl なし）', async () => {
    await render({ initialIndex: 1 });

    await recordedButton('投稿した')?.onClick?.(clickEvent);

    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
    expect(capture.apiRequest.mock.calls[0]?.[0]).toBe(
      `/api/v1/social/posts/${TARGETS[1]?.id}/manual-outcome`,
    );
    expect(capture.apiRequest.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: { outcome: 'posted', expectedUpdatedAt: TARGETS[1]?.updatedAt },
    });
    expect(Object.keys(capture.apiRequest.mock.calls[0]?.[1]?.body ?? {})).not.toContain(
      'externalUrl',
    );
  });

  it('#55 「投稿した」を押しても open は呼ばれない（次の窓を自動で開かない）', async () => {
    const open = vi.fn();
    await render({ initialIndex: 1, open });

    await recordedButton('投稿した')?.onClick?.(clickEvent);

    expect(open).not.toHaveBeenCalled();
  });

  it('#56 「投稿しなかった」の onClick はまだ送らない（ダイアログの中で確認に切り替える）', async () => {
    await render({ initialIndex: 1 });

    await recordedButton('投稿しなかった')?.onClick?.(clickEvent);

    expect(capture.apiRequest).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* #56 「投稿しなかった」の確認                                                     */
/* -------------------------------------------------------------------------- */

describe('#56 ManualSequence（initialConfirming: true）', () => {
  it('#56 今の件を失敗として確定するかの確認', async () => {
    const text = textOf(await render({ initialIndex: 1, initialConfirming: true }));

    expect(text).toContain('失敗として確定しますか？');
    expect(text).toContain('新製品のお知らせです。');
  });

  it('#56 配信履歴に「失敗」として残る・新しい投稿を作る・取り消せないことを書く', async () => {
    const text = textOf(await render({ initialIndex: 1, initialConfirming: true }));

    expect(text).toContain('配信履歴に「失敗」として残ります。');
    expect(text).toContain('やり直すには新しい投稿を作ります。');
    expect(text).toContain('この操作は取り消せません。');
  });

  it('#56 「戻る」「失敗にする」のボタンがある', async () => {
    const labels = buttonTexts(await render({ initialIndex: 1, initialConfirming: true }));

    expect(labels).toContain('戻る');
    expect(labels).toContain('失敗にする');
  });

  it('#56 「失敗にする」の onClick で manual-outcome に not_posted と今の件の updatedAt を送る（externalUrl なし）', async () => {
    await render({ initialIndex: 1, initialConfirming: true });

    await recordedButton('失敗にする')?.onClick?.(clickEvent);

    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
    expect(capture.apiRequest.mock.calls[0]?.[0]).toBe(
      `/api/v1/social/posts/${TARGETS[1]?.id}/manual-outcome`,
    );
    expect(capture.apiRequest.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: { outcome: 'not_posted', expectedUpdatedAt: TARGETS[1]?.updatedAt },
    });
    expect(Object.keys(capture.apiRequest.mock.calls[0]?.[1]?.body ?? {})).not.toContain(
      'externalUrl',
    );
  });

  it('#56 「戻る」は送らない', async () => {
    await render({ initialIndex: 1, initialConfirming: true });

    await recordedButton('戻る')?.onClick?.(clickEvent);

    expect(capture.apiRequest).not.toHaveBeenCalled();
  });

  it('#56 確認しているときは記録の 2 つのボタン（投稿した・投稿しなかった）を出さない', async () => {
    const labels = buttonTexts(await render({ initialIndex: 1, initialConfirming: true }));

    expect(labels).not.toContain('投稿した');
    expect(labels).not.toContain('投稿しなかった');
  });

  it('#56 initialConfirming を渡さなければ確認は出ない', async () => {
    expect(textOf(await render({ initialIndex: 1 }))).not.toContain('失敗として確定しますか？');
  });
});

/* -------------------------------------------------------------------------- */
/* #57 終わりの表示                                                               */
/* -------------------------------------------------------------------------- */

describe('#57 ManualSequence（すべて記録した後）', () => {
  const records: readonly SequenceRecord[] = [
    { id: TARGETS[0]?.id ?? '', outcome: 'posted' },
    { id: TARGETS[1]?.id ?? '', outcome: 'not_posted' },
    { id: TARGETS[2]?.id ?? '', outcome: 'posted' },
  ];

  it('#57 「すべての手動投稿を記録しました（投稿した 2・投稿しなかった 1・飛ばした 0）。」', async () => {
    expect(textOf(await render({ initialIndex: 3, initialRecords: records }))).toContain(
      'すべての手動投稿を記録しました（投稿した 2・投稿しなかった 1・飛ばした 0）。',
    );
  });

  it('#57 「閉じる」のボタンがある', async () => {
    expect(buttonTexts(await render({ initialIndex: 3, initialRecords: records }))).toContain(
      '閉じる',
    );
  });

  it('#57 終わりの表示には「投稿画面を開く」「投稿した」「投稿しなかった」が無い', async () => {
    const labels = buttonTexts(await render({ initialIndex: 3, initialRecords: records }));

    for (const label of ['投稿画面を開く', '投稿した', '投稿しなかった']) {
      expect(labels, label).not.toContain(label);
    }
  });

  it('#57 飛ばした件も数える', async () => {
    const withSkip: readonly SequenceRecord[] = [
      { id: TARGETS[0]?.id ?? '', outcome: 'posted' },
      { id: TARGETS[1]?.id ?? '', outcome: 'skipped' },
      { id: TARGETS[2]?.id ?? '', outcome: 'not_posted' },
    ];

    expect(textOf(await render({ initialIndex: 3, initialRecords: withSkip }))).toContain(
      'すべての手動投稿を記録しました（投稿した 1・投稿しなかった 1・飛ばした 1）。',
    );
  });
});
