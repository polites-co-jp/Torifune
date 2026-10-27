import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonsLabelled,
  change,
  click,
  findAll,
  flush,
  hookHarness,
  textOfNodes,
  type HostNode,
} from '@/test-support/hook-harness';
import { MANUAL_SEQUENCE_STALE_MESSAGE } from './labels';

/**
 * 順に投稿のダイアログ（057-social-bulk-post 設計 §5.4・§7.5、受け入れ条件 #29〜#39。055 #55〜#57・G12 を作り直した）。
 *
 * * #29 `ready`：見出し「手動投稿（1 / n 件目）」・本文の全文・「投稿画面を開く」「別のタブで開く」「記録へ進む」「やめる」。
 *   「投稿した」「投稿しなかった」・URL の欄が無い。描画しただけでは `open` が呼ばれない
 * * #30 「投稿画面を開く」→ `open` が 1 回、段が `opened`（案内と「記録へ進む」、「投稿した」が無い）
 * * #31 「記録へ進む」→ `returned`（URL の欄・「投稿した」「投稿しなかった」「やめる」、次の件があれば次の案内）
 * * #32 「投稿した」→ 次の件の URL で `open` が 1 回、**`manual-outcome` の要求より先に**。成功で次の件が `opened`
 *   （055 #55 の「投稿した を押しても open は呼ばれない」は、要望どおり**反対の期待**に作り直した。057 設計 §14.1）
 * * #33 「投稿しなかった」→ 確認 →「戻る」は何もしない、「失敗にする」で #32 と同じ順に `open` と `not_posted`
 * * #34 最後の件は `open` を呼ばず、記録の後に終わりの表示
 * * #35 409 と「飛ばして次へ」（開き直さない）、409 以外はサーバの文言
 * * #36 対象の `updatedAt`（承認した手動では承認の結果の値）を `expectedUpdatedAt` に送る
 * * #37 保存中の `disabled`
 * * #38 「やめる」→ 終わりの表示に「記録していない手動投稿 n 件は送信待ちに残ります。」→「閉じる」で `onFinish(records, { quit })`
 * * #39 終わりの表示：1 段目の結果（`summary`）・記録の件数・「閉じる」。「投稿画面を開く」「投稿した」が無い
 *
 * **props は実装プラン §8 の 11 の形**：`targets`（`ManualSequenceTarget` の並び）・`accountNames`・`firstOpened?`・
 * `summary?`・`onFinish(records, { quit })`・`open?`、テストの口 `initialIndex?`・`initialRecords?`・`initialConfirming?`・
 * `initialStage?`。部品の props が変わるので、指定子を `string` の定数に置いた動的 import で読み、型をテストに写して `as` で渡す。
 *
 * 押した後の状態は描画器（`test-support/hook-harness.ts`）で見る。**`useEffect` は走らない**ので、`focus`・`blur` による
 * 「戻った」はここでは起こさない（段の移り方は `manual-sequence-plan.test.ts` #21、画面は E2E #52・#53）。
 */

vi.mock('react', async (importOriginal) => {
  const { withHookHarness } = await import('@/test-support/hook-harness');
  return withHookHarness(await importOriginal());
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const capture = vi.hoisted(() => ({ apiRequest: vi.fn(), log: [] as string[] }));

vi.mock('@/ui/client/api-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/client/api-client');
  return { ...actual, apiRequest: capture.apiRequest };
});

/* -------------------------------------------------------------------------- */
/* 型（設計 §5.4・§7.5、実装プラン §2・§8 の 11 から写す）                              */
/* -------------------------------------------------------------------------- */

type WindowStage = 'ready' | 'opened' | 'returned';

interface ManualSequenceTarget {
  readonly id: string;
  readonly body: string;
  readonly socialAccountId: string;
  readonly scheduledAt: string | null;
  readonly updatedAt: string;
  readonly url: string;
  readonly note: string | null;
}

interface SequenceRecord {
  readonly id: string;
  readonly outcome: 'posted' | 'not_posted' | 'skipped';
}

type OnFinish = (records: readonly SequenceRecord[], options: { readonly quit: boolean }) => void;

interface SequenceProps {
  readonly targets: readonly ManualSequenceTarget[];
  readonly accountNames: Readonly<Record<string, string>>;
  readonly onFinish: OnFinish;
  readonly firstOpened?: boolean;
  readonly summary?: ReactNode;
  readonly open?: (url: string, name: string, features: string) => unknown;
  readonly initialIndex?: number;
  readonly initialRecords?: readonly SequenceRecord[];
  readonly initialConfirming?: boolean;
  readonly initialStage?: WindowStage;
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
/* 文言（設計 §5.4・§7.5・§7.6、055 §9.5.2）                                         */
/* -------------------------------------------------------------------------- */

const OPEN_LABEL = '投稿画面を開く';
const FALLBACK_LABEL = '別のタブで開く';
const RECORD_NOW_LABEL = '記録へ進む';
const POSTED_LABEL = '投稿した';
const NOT_POSTED_LABEL = '投稿しなかった';
const QUIT_LABEL = 'やめる';
const SKIP_LABEL = '飛ばして次へ';
const BACK_LABEL = '戻る';
const CONFIRM_FAIL_LABEL = '失敗にする';
const CLOSE_LABEL = '閉じる';
const RESULT_TITLE = '一括投稿の結果';
const OPENED_GUIDE =
  'SNS の窓で投稿したら、窓を閉じてこの画面に戻ってください。戻ると記録のボタンが出ます。窓が開かないときは『別のタブで開く』を使ってください。';
const NEXT_GUIDE = '選ぶと次の投稿画面が開きます。';
const NEXT_OPENED = '次の投稿画面は開いています。';
const WINDOW_NAME = 'torifune-manual-post';
const WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000057a1';
const ACCOUNT_NAMES = { [ACCOUNT_ID]: 'X（@torifune）' };

function target(
  index: number,
  overrides: Partial<ManualSequenceTarget> = {},
): ManualSequenceTarget {
  return {
    id: `01900000-0000-7000-8000-0000005700${String(index).padStart(2, '0')}`,
    body: `${index} 件目の手動投稿の本文です。`,
    socialAccountId: ACCOUNT_ID,
    scheduledAt: '2026-10-27T01:00:00.000Z',
    updatedAt: `2026-10-27T00:00:0${index}.123Z`,
    url: `https://example.com/intent?text=${index}`,
    note: null,
    ...overrides,
  };
}

const LONG_BODY = `${'新製品のお知らせです。'.repeat(30)}最後まで全文を出す`;

const TARGETS: readonly ManualSequenceTarget[] = [
  target(1),
  target(2, { body: LONG_BODY, note: '画像は投稿画面で添付してください' }),
  target(3),
];

const FIRST = TARGETS[0] as ManualSequenceTarget;
const SECOND = TARGETS[1] as ManualSequenceTarget;
const THIRD = TARGETS[2] as ManualSequenceTarget;

const STALE = {
  ok: false,
  error: { code: 'CONFLICT', message: 'サーバの 409 の文言です。', status: 409 },
} as const;

/* -------------------------------------------------------------------------- */
/* 描画                                                                         */
/* -------------------------------------------------------------------------- */

let ManualSequence: ComponentType<SequenceProps>;
let onFinish: ReturnType<typeof vi.fn<OnFinish>>;
let open: ReturnType<typeof vi.fn<(url: string, name: string, features: string) => unknown>>;

function props(overrides: Partial<SequenceProps>): SequenceProps {
  return { targets: TARGETS, accountNames: ACCOUNT_NAMES, onFinish, open, ...overrides };
}

/** 描画器で描く（同じ props で呼び直すと前の状態のまま描き直す）。 */
function draw(overrides: Partial<SequenceProps> = {}): readonly HostNode[] {
  return hookHarness.render(createElement(ManualSequence, props(overrides)));
}

function html(overrides: Partial<SequenceProps> = {}): string {
  return renderToStaticMarkup(createElement(ManualSequence, props(overrides)));
}

function text(nodes: readonly HostNode[]): string {
  return textOfNodes(nodes);
}

function only(nodes: readonly HostNode[], label: string): HostNode {
  const found = buttonsLabelled(nodes, label);
  expect(found, `「${label}」のボタン`).toHaveLength(1);
  return found[0] as HostNode;
}

function has(nodes: readonly HostNode[], label: string): boolean {
  return buttonsLabelled(nodes, label).length > 0;
}

function urlInput(nodes: readonly HostNode[]): HostNode | undefined {
  return findAll(nodes, (node) => node.type === 'input' && node.props['name'] === 'externalUrl')[0];
}

function fallbackLink(nodes: readonly HostNode[]): HostNode | undefined {
  return findAll(nodes, (node) => node.type === 'a' && node.text.trim() === FALLBACK_LABEL)[0];
}

function alertText(nodes: readonly HostNode[]): string {
  return findAll(nodes, (node) => node.props['role'] === 'alert')
    .map((node) => node.text)
    .join('');
}

function dialogNames(nodes: readonly HostNode[]): string[] {
  return findAll(nodes, (node) => node.props['role'] === 'dialog').map((node) =>
    String(node.props['aria-label'] ?? ''),
  );
}

/** 解決を手で決める Promise（保存中の状態を見る）。 */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  hookHarness.reset();
  hookHarness.leaves.clear();
  capture.log.length = 0;
  capture.apiRequest.mockReset();
  capture.apiRequest.mockImplementation(async (path: string) => {
    capture.log.push(`api:${path}`);
    return { ok: true, data: {} };
  });
  onFinish = vi.fn<OnFinish>();
  open = vi.fn<(url: string, name: string, features: string) => unknown>((url: string) => {
    capture.log.push(`open:${url}`);
    return null;
  });
  ManualSequence = await loadComponent();
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* #29 ready                                                                    */
/* -------------------------------------------------------------------------- */

describe('#29 ready（開いていない）', () => {
  it('#29 見出しが「手動投稿（1 / 3 件目）」', () => {
    expect(dialogNames(draw())).toContain('手動投稿（1 / 3 件目）');
  });

  it('#29 initialIndex: 1 で「手動投稿（2 / 3 件目）」と 2 件目の本文の全文（抜粋しない）', () => {
    const nodes = draw({ initialIndex: 1 });

    expect(dialogNames(nodes)).toContain('手動投稿（2 / 3 件目）');
    expect(text(nodes)).toContain(LONG_BODY);
    expect(text(nodes)).not.toContain(FIRST.body);
    expect(text(nodes)).not.toContain(THIRD.body);
  });

  it('#29 本文は overflow-wrap: anywhere（長い本文・URL でもダイアログの幅に収まる）', () => {
    expect(html({ initialIndex: 1 })).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('#29 アカウントの表示名と note（本文の下）を出す', () => {
    const value = text(draw({ initialIndex: 1 }));

    expect(value).toContain('X（@torifune）');
    expect(value.indexOf('画像は投稿画面で添付してください')).toBeGreaterThan(
      value.indexOf('最後まで全文を出す'),
    );
  });

  it('#29 「投稿画面を開く」「記録へ進む」「やめる」のボタンがある', () => {
    const nodes = draw();

    for (const label of [OPEN_LABEL, RECORD_NOW_LABEL, QUIT_LABEL]) {
      expect(has(nodes, label), label).toBe(true);
    }
  });

  it('#29 「別のタブで開く」リンクは同じ URL・target="_blank"・rel="noopener noreferrer"', () => {
    const link = fallbackLink(draw());

    expect(link, FALLBACK_LABEL).toBeDefined();
    expect(link?.props['href']).toBe(FIRST.url);
    expect(link?.props['target']).toBe('_blank');
    expect(link?.props['rel']).toBe('noopener noreferrer');
  });

  it('#29 「投稿した」「投稿しなかった」のボタンと URL の欄が無い', () => {
    const nodes = draw();

    expect(has(nodes, POSTED_LABEL)).toBe(false);
    expect(has(nodes, NOT_POSTED_LABEL)).toBe(false);
    expect(urlInput(nodes)).toBeUndefined();
  });

  it('#29 ready では opened の案内を出さない', () => {
    expect(text(draw())).not.toContain(OPENED_GUIDE);
  });

  it('#29 描画しただけでは open が呼ばれない（描画器・静的描画の両方）', () => {
    draw();
    draw({ initialIndex: 1 });
    html();

    expect(open).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* #30 opened                                                                   */
/* -------------------------------------------------------------------------- */

describe('#30 「投稿画面を開く」→ opened', () => {
  it('#30 今の件の URL を (url, 窓の名前, 開き方) で 1 回開く', () => {
    click(only(draw(), OPEN_LABEL));

    expect(open.mock.calls).toEqual([[FIRST.url, WINDOW_NAME, WINDOW_FEATURES]]);
  });

  it('#30 開いた後は opened の案内と「記録へ進む」があり、「投稿した」が無い', () => {
    click(only(draw(), OPEN_LABEL));
    const nodes = draw();

    expect(text(nodes)).toContain(OPENED_GUIDE);
    expect(has(nodes, RECORD_NOW_LABEL)).toBe(true);
    expect(has(nodes, POSTED_LABEL)).toBe(false);
    expect(urlInput(nodes)).toBeUndefined();
  });

  it('#30 opened でも「投稿画面を開く」（開き直し）・「別のタブで開く」・「やめる」がある', () => {
    click(only(draw(), OPEN_LABEL));
    const nodes = draw();

    expect(has(nodes, OPEN_LABEL)).toBe(true);
    expect(fallbackLink(nodes)).toBeDefined();
    expect(has(nodes, QUIT_LABEL)).toBe(true);
  });

  it('#30 「別のタブで開く」を押しても opened になる（実装プラン §8 の 13）', () => {
    const link = fallbackLink(draw());
    const onClick = link?.props['onClick'];

    expect(typeof onClick, '「別のタブで開く」の onClick').toBe('function');
    (onClick as (event: unknown) => void)({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });

    expect(text(draw())).toContain(OPENED_GUIDE);
    expect(open).not.toHaveBeenCalled();
  });

  it('#30 firstOpened：1 件目が opened から始まり、描画では open を呼ばない', () => {
    const nodes = draw({ firstOpened: true });

    expect(dialogNames(nodes)).toContain('手動投稿（1 / 3 件目）');
    expect(text(nodes)).toContain(OPENED_GUIDE);
    expect(has(nodes, POSTED_LABEL)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* #31 returned                                                                 */
/* -------------------------------------------------------------------------- */

describe('#31 「記録へ進む」→ returned', () => {
  it('#31 ready から：URL の欄・「投稿した」「投稿しなかった」「やめる」', () => {
    click(only(draw(), RECORD_NOW_LABEL));
    const nodes = draw();

    expect(urlInput(nodes)).toBeDefined();
    for (const label of [POSTED_LABEL, NOT_POSTED_LABEL, QUIT_LABEL]) {
      expect(has(nodes, label), label).toBe(true);
    }
  });

  it('#31 opened から：同じく returned になる', () => {
    click(only(draw(), OPEN_LABEL));
    click(only(draw(), RECORD_NOW_LABEL));
    const nodes = draw();

    expect(has(nodes, POSTED_LABEL)).toBe(true);
    expect(text(nodes)).not.toContain(OPENED_GUIDE);
  });

  it('#31 returned では「記録へ進む」が無く、「投稿画面を開く」「別のタブで開く」はある', () => {
    click(only(draw(), RECORD_NOW_LABEL));
    const nodes = draw();

    expect(has(nodes, RECORD_NOW_LABEL)).toBe(false);
    expect(has(nodes, OPEN_LABEL)).toBe(true);
    expect(fallbackLink(nodes)).toBeDefined();
  });

  it('#31 次の件があれば「選ぶと次の投稿画面が開きます。」', () => {
    click(only(draw(), RECORD_NOW_LABEL));

    expect(text(draw())).toContain(NEXT_GUIDE);
  });

  it('#31 最後の件では次の案内を出さない', () => {
    const last = { initialIndex: 2 };
    click(only(draw(last), RECORD_NOW_LABEL));

    expect(text(draw(last))).not.toContain(NEXT_GUIDE);
  });

  it('#31 initialStage: returned でも同じ表示（テストの口）', () => {
    const nodes = draw({ initialStage: 'returned' });

    expect(has(nodes, POSTED_LABEL)).toBe(true);
    expect(urlInput(nodes)).toBeDefined();
  });

  it('#31 「記録へ進む」では open も要求も送らない', () => {
    click(only(draw(), RECORD_NOW_LABEL));

    expect(open).not.toHaveBeenCalled();
    expect(capture.apiRequest).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* #32 「投稿した」                                                               */
/* -------------------------------------------------------------------------- */

describe('#32 returned で「投稿した」', () => {
  const returned = { initialStage: 'returned' } as const;

  it('#32 次の件の URL で open が 1 回、manual-outcome の要求より先に呼ばれる', async () => {
    click(only(draw(returned), POSTED_LABEL));
    await flush();

    expect(open.mock.calls).toEqual([[SECOND.url, WINDOW_NAME, WINDOW_FEATURES]]);
    expect(capture.log).toEqual([
      `open:${SECOND.url}`,
      `api:/api/v1/social/posts/${FIRST.id}/manual-outcome`,
    ]);
  });

  it('#32 次の窓はクリックの同期処理の中で開く（await の前）', () => {
    click(only(draw(returned), POSTED_LABEL));

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('#32 要求は { outcome: posted, expectedUpdatedAt: 対象の updatedAt }（URL が空なら externalUrl なし）', async () => {
    click(only(draw(returned), POSTED_LABEL));
    await flush();

    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
    expect(capture.apiRequest).toHaveBeenCalledWith(
      `/api/v1/social/posts/${FIRST.id}/manual-outcome`,
      { method: 'POST', body: { outcome: 'posted', expectedUpdatedAt: FIRST.updatedAt } },
    );
  });

  it('#32 URL を入れれば externalUrl も送る', async () => {
    change(urlInput(draw(returned)), 'https://x.com/i/status/1');
    click(only(draw(returned), POSTED_LABEL));
    await flush();

    expect(capture.apiRequest).toHaveBeenCalledWith(
      `/api/v1/social/posts/${FIRST.id}/manual-outcome`,
      {
        method: 'POST',
        body: {
          outcome: 'posted',
          expectedUpdatedAt: FIRST.updatedAt,
          externalUrl: 'https://x.com/i/status/1',
        },
      },
    );
  });

  it('#32 成功で「手動投稿（2 / 3 件目）」が opened で出る（「投稿した」が無く、opened の案内がある）', async () => {
    click(only(draw(returned), POSTED_LABEL));
    await flush();
    const nodes = draw(returned);

    expect(dialogNames(nodes)).toContain('手動投稿（2 / 3 件目）');
    expect(text(nodes)).toContain(LONG_BODY);
    expect(text(nodes)).toContain(OPENED_GUIDE);
    expect(has(nodes, POSTED_LABEL)).toBe(false);
  });

  it('#32 成功の後は記録済みの件数（投稿した 1）を出す', async () => {
    click(only(draw(returned), POSTED_LABEL));
    await flush();

    expect(text(draw(returned))).toContain('記録済み 1 件（投稿した 1）');
  });
});

/* -------------------------------------------------------------------------- */
/* #33 「投稿しなかった」                                                          */
/* -------------------------------------------------------------------------- */

describe('#33 「投稿しなかった」→ 確認', () => {
  const returned = { initialStage: 'returned' } as const;

  it('#33 「投稿しなかった」ではまだ送らず、確認（055 の文言・「戻る」「失敗にする」）に切り替える', () => {
    click(only(draw(returned), NOT_POSTED_LABEL));
    const nodes = draw(returned);

    expect(capture.apiRequest).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(text(nodes)).toContain('失敗として確定しますか？');
    expect(text(nodes)).toContain('配信履歴に「失敗」として残ります。');
    expect(text(nodes)).toContain('やり直すには新しい投稿を作ります。');
    expect(text(nodes)).toContain('この操作は取り消せません。');
    expect(has(nodes, BACK_LABEL)).toBe(true);
    expect(has(nodes, CONFIRM_FAIL_LABEL)).toBe(true);
    expect(has(nodes, POSTED_LABEL)).toBe(false);
  });

  it('#33 「戻る」では open も要求も無く、記録のボタンに戻る', () => {
    click(only(draw(returned), NOT_POSTED_LABEL));
    click(only(draw(returned), BACK_LABEL));
    const nodes = draw(returned);

    expect(open).not.toHaveBeenCalled();
    expect(capture.apiRequest).not.toHaveBeenCalled();
    expect(has(nodes, POSTED_LABEL)).toBe(true);
  });

  it('#33 「失敗にする」で次の URL の open が要求より先、本文は { outcome: not_posted, expectedUpdatedAt }（externalUrl なし）', async () => {
    change(urlInput(draw(returned)), 'https://x.com/i/status/1');
    click(only(draw(returned), NOT_POSTED_LABEL));
    click(only(draw(returned), CONFIRM_FAIL_LABEL));
    await flush();

    expect(capture.log).toEqual([
      `open:${SECOND.url}`,
      `api:/api/v1/social/posts/${FIRST.id}/manual-outcome`,
    ]);
    expect(capture.apiRequest).toHaveBeenCalledWith(
      `/api/v1/social/posts/${FIRST.id}/manual-outcome`,
      { method: 'POST', body: { outcome: 'not_posted', expectedUpdatedAt: FIRST.updatedAt } },
    );
  });

  it('#33 initialConfirming（テストの口）で確認を開いた状態から「失敗にする」も同じ', async () => {
    const confirming = { initialStage: 'returned', initialConfirming: true } as const;
    click(only(draw(confirming), CONFIRM_FAIL_LABEL));
    await flush();

    expect(open.mock.calls).toEqual([[SECOND.url, WINDOW_NAME, WINDOW_FEATURES]]);
    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
  });

  it('#33 成功で次の件が opened で出る', async () => {
    click(only(draw(returned), NOT_POSTED_LABEL));
    click(only(draw(returned), CONFIRM_FAIL_LABEL));
    await flush();
    const nodes = draw(returned);

    expect(dialogNames(nodes)).toContain('手動投稿（2 / 3 件目）');
    expect(text(nodes)).toContain(OPENED_GUIDE);
  });
});

/* -------------------------------------------------------------------------- */
/* #34 最後の件                                                                  */
/* -------------------------------------------------------------------------- */

describe('#34 最後の件の「投稿した」', () => {
  const last = { initialIndex: 2, initialStage: 'returned' } as const;

  it('#34 open は呼ばれない', async () => {
    click(only(draw(last), POSTED_LABEL));
    await flush();

    expect(open).not.toHaveBeenCalled();
  });

  it('#34 記録の後に終わりの表示（「一括投稿の結果」と「閉じる」）', async () => {
    click(only(draw(last), POSTED_LABEL));
    await flush();
    const nodes = draw(last);

    expect(dialogNames(nodes)).toContain(RESULT_TITLE);
    expect(has(nodes, CLOSE_LABEL)).toBe(true);
  });

  it('#34 最後の件の「失敗にする」も open を呼ばない', async () => {
    click(only(draw(last), NOT_POSTED_LABEL));
    click(only(draw(last), CONFIRM_FAIL_LABEL));
    await flush();

    expect(open).not.toHaveBeenCalled();
    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #35 記録の失敗                                                                 */
/* -------------------------------------------------------------------------- */

describe('#35 記録の失敗と「飛ばして次へ」', () => {
  const returned = { initialStage: 'returned' } as const;

  it('#35 409 → Alert は MANUAL_SEQUENCE_STALE_MESSAGE（サーバの文言ではない）', async () => {
    capture.apiRequest.mockResolvedValue(STALE);

    click(only(draw(returned), POSTED_LABEL));
    await flush();
    const value = alertText(draw(returned));

    expect(value).toContain(MANUAL_SEQUENCE_STALE_MESSAGE);
    expect(value).not.toContain('サーバの 409 の文言です。');
  });

  it('#35 409 の後のボタンは「飛ばして次へ」「やめる」（「投稿した」は無い）', async () => {
    capture.apiRequest.mockResolvedValue(STALE);

    click(only(draw(returned), POSTED_LABEL));
    await flush();
    const nodes = draw(returned);

    expect(has(nodes, SKIP_LABEL)).toBe(true);
    expect(has(nodes, QUIT_LABEL)).toBe(true);
    expect(has(nodes, POSTED_LABEL)).toBe(false);
  });

  it('#35 次の窓を開いていれば「次の投稿画面は開いています。」', async () => {
    capture.apiRequest.mockResolvedValue(STALE);

    click(only(draw(returned), POSTED_LABEL));
    await flush();

    expect(text(draw(returned))).toContain(NEXT_OPENED);
  });

  it('#35 「飛ばして次へ」で次の件が opened で出て、open の回数は増えない（開き直さない）', async () => {
    capture.apiRequest.mockResolvedValue(STALE);

    click(only(draw(returned), POSTED_LABEL));
    await flush();
    click(only(draw(returned), SKIP_LABEL));
    const nodes = draw(returned);

    expect(dialogNames(nodes)).toContain('手動投稿（2 / 3 件目）');
    expect(text(nodes)).toContain(OPENED_GUIDE);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('#35 飛ばした件は「記録済み 1 件（飛ばした 1）」と数え、投稿したと数えない', async () => {
    capture.apiRequest.mockResolvedValue(STALE);

    click(only(draw(returned), POSTED_LABEL));
    await flush();
    click(only(draw(returned), SKIP_LABEL));
    const value = text(draw(returned));

    expect(value).toContain('記録済み 1 件（飛ばした 1）');
    expect(value).not.toContain('投稿した 1');
  });

  it('#35 最後の件の 409 では「次の投稿画面は開いています。」を出さない', async () => {
    capture.apiRequest.mockResolvedValue(STALE);
    const last = { initialIndex: 2, initialStage: 'returned' } as const;

    click(only(draw(last), POSTED_LABEL));
    await flush();

    expect(text(draw(last))).not.toContain(NEXT_OPENED);
  });

  it('#35 409 以外の失敗（422）はサーバの文言を出す', async () => {
    capture.apiRequest.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '入力の内容を確かめてください。', status: 422 },
    });

    click(only(draw(returned), POSTED_LABEL));
    await flush();

    expect(alertText(draw(returned))).toContain('入力の内容を確かめてください。');
  });

  it('#35 「失敗にする」が 409 でも MANUAL_SEQUENCE_STALE_MESSAGE', async () => {
    capture.apiRequest.mockResolvedValue(STALE);
    const confirming = { initialStage: 'returned', initialConfirming: true } as const;

    click(only(draw(confirming), CONFIRM_FAIL_LABEL));
    await flush();

    expect(alertText(draw(confirming))).toContain(MANUAL_SEQUENCE_STALE_MESSAGE);
  });
});

/* -------------------------------------------------------------------------- */
/* #36 expectedUpdatedAt                                                        */
/* -------------------------------------------------------------------------- */

describe('#36 承認した手動投稿の expectedUpdatedAt', () => {
  it('#36 対象の updatedAt（承認の結果の post.updatedAt）をそのまま送る', async () => {
    const approved = target(7, { updatedAt: '2026-10-27T01:23:45.678Z' });

    click(only(draw({ targets: [approved], initialStage: 'returned' }), POSTED_LABEL));
    await flush();

    expect(capture.apiRequest).toHaveBeenCalledWith(
      `/api/v1/social/posts/${approved.id}/manual-outcome`,
      {
        method: 'POST',
        body: { outcome: 'posted', expectedUpdatedAt: '2026-10-27T01:23:45.678Z' },
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #37 保存中                                                                    */
/* -------------------------------------------------------------------------- */

describe('#37 保存中の disabled', () => {
  it('#37 「投稿した」「投稿しなかった」「やめる」が disabled（押す前は disabled でない）', async () => {
    const returned = { initialStage: 'returned' } as const;
    const pending = deferred();
    capture.apiRequest.mockReturnValue(pending.promise);
    const before = draw(returned);

    for (const label of [POSTED_LABEL, NOT_POSTED_LABEL, QUIT_LABEL]) {
      expect(only(before, label).props['disabled'], `押す前の「${label}」`).not.toBe(true);
    }

    click(only(before, POSTED_LABEL));
    const saving = draw(returned);

    for (const label of [POSTED_LABEL, NOT_POSTED_LABEL, QUIT_LABEL]) {
      expect(only(saving, label).props['disabled'], `保存中の「${label}」`).toBe(true);
    }

    pending.resolve({ ok: true, data: {} });
    await flush();
  });

  it('#37 確認の「失敗にする」で保存中は「戻る」「失敗にする」が disabled', async () => {
    const confirming = { initialStage: 'returned', initialConfirming: true } as const;
    const pending = deferred();
    capture.apiRequest.mockReturnValue(pending.promise);
    const before = draw(confirming);

    expect(only(before, CONFIRM_FAIL_LABEL).props['disabled']).not.toBe(true);

    click(only(before, CONFIRM_FAIL_LABEL));
    const saving = draw(confirming);

    expect(only(saving, BACK_LABEL).props['disabled']).toBe(true);
    expect(only(saving, CONFIRM_FAIL_LABEL).props['disabled']).toBe(true);

    pending.resolve({ ok: true, data: {} });
    await flush();
  });
});

/* -------------------------------------------------------------------------- */
/* #38 やめる                                                                    */
/* -------------------------------------------------------------------------- */

describe('#38 「やめる」と「閉じる」', () => {
  it('#38 1 件を記録した後、2 件目で「やめる」→ 終わりの表示に「記録していない手動投稿 2 件は送信待ちに残ります。」', async () => {
    const returned = { initialStage: 'returned' } as const;
    click(only(draw(returned), POSTED_LABEL));
    await flush();
    click(only(draw(returned), QUIT_LABEL));
    const nodes = draw(returned);

    expect(dialogNames(nodes)).toContain(RESULT_TITLE);
    expect(text(nodes)).toContain('記録していない手動投稿 2 件は送信待ちに残ります。');
  });

  it('#38 「やめる」では要求を送らない（まだ記録していない件は何も変えない）', () => {
    click(only(draw(), QUIT_LABEL));

    expect(capture.apiRequest).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('#38 ready の 1 件目で「やめる」→「記録していない手動投稿 3 件は送信待ちに残ります。」', () => {
    click(only(draw(), QUIT_LABEL));

    expect(text(draw())).toContain('記録していない手動投稿 3 件は送信待ちに残ります。');
  });

  it('#38 やめた後の「閉じる」で onFinish(records, { quit: true }) を 1 回呼ぶ', async () => {
    const returned = { initialStage: 'returned' } as const;
    click(only(draw(returned), POSTED_LABEL));
    await flush();
    click(only(draw(returned), QUIT_LABEL));
    click(only(draw(returned), CLOSE_LABEL));

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith([{ id: FIRST.id, outcome: 'posted' }], { quit: true });
  });

  it('#38 すべて記録した後の「閉じる」は onFinish(records, { quit: false })', async () => {
    const records: readonly SequenceRecord[] = [
      { id: FIRST.id, outcome: 'posted' },
      { id: SECOND.id, outcome: 'skipped' },
      { id: THIRD.id, outcome: 'not_posted' },
    ];
    click(only(draw({ initialIndex: 3, initialRecords: records }), CLOSE_LABEL));

    expect(onFinish).toHaveBeenCalledWith(records, { quit: false });
  });

  it('#38 すべて記録したときは「記録していない手動投稿」を出さない', () => {
    const records: readonly SequenceRecord[] = TARGETS.map((item) => ({
      id: item.id,
      outcome: 'posted',
    }));

    expect(text(draw({ initialIndex: 3, initialRecords: records }))).not.toContain(
      '記録していない手動投稿',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #39 終わりの表示                                                               */
/* -------------------------------------------------------------------------- */

describe('#39 終わりの表示', () => {
  const records: readonly SequenceRecord[] = [
    { id: FIRST.id, outcome: 'posted' },
    { id: SECOND.id, outcome: 'not_posted' },
    { id: THIRD.id, outcome: 'posted' },
  ];
  const SUMMARY = createElement('p', { 'data-summary': 'true' }, '2 件を処理しました（承認 2）。');
  const done = { initialIndex: 3, initialRecords: records, summary: SUMMARY } as const;

  it('#39 題は「一括投稿の結果」', () => {
    expect(dialogNames(draw(done))).toContain(RESULT_TITLE);
  });

  it('#39 1 段目の結果（summary）を出す', () => {
    expect(text(draw(done))).toContain('2 件を処理しました（承認 2）。');
  });

  it('#39 記録の件数（投稿した 2・投稿しなかった 1）を出し、0 件の結果（飛ばした 0）は書かない', () => {
    const value = text(draw(done));

    expect(value).toMatch(/投稿した\s*2\s*・\s*投稿しなかった\s*1/);
    expect(value).not.toMatch(/飛ばした\s*0/);
  });

  it('#39 飛ばした件も数える', () => {
    const withSkip: readonly SequenceRecord[] = [
      { id: FIRST.id, outcome: 'posted' },
      { id: SECOND.id, outcome: 'skipped' },
      { id: THIRD.id, outcome: 'not_posted' },
    ];

    expect(text(draw({ initialIndex: 3, initialRecords: withSkip }))).toMatch(/飛ばした\s*1/);
  });

  it('#39 「閉じる」があり、「投稿画面を開く」「投稿した」「投稿しなかった」「記録へ進む」が無い', () => {
    const nodes = draw(done);

    expect(has(nodes, CLOSE_LABEL)).toBe(true);
    for (const label of [OPEN_LABEL, POSTED_LABEL, NOT_POSTED_LABEL, RECORD_NOW_LABEL]) {
      expect(has(nodes, label), label).toBe(false);
    }
  });

  it('#39 終わりの表示では open を呼ばない', () => {
    draw(done);

    expect(open).not.toHaveBeenCalled();
  });
});
