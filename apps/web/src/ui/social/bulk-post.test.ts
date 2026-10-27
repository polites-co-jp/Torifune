import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Link from 'next/link';
import type { BulkEffect, BulkFailureReason } from '@/domain/social/bulk';
import {
  buttonsLabelled,
  click,
  findAll,
  flush,
  hookHarness,
  textOfNodes,
  type HostNode,
} from '@/test-support/hook-harness';

/**
 * 送信待ちタブの一括投稿（057-social-bulk-post 設計 §5.2・§5.3・§7.2〜§7.4、受け入れ条件 #22〜#28）。
 *
 * * #22 帯に「一括投稿…」「一括取り消し…」がこの順にあり、「一括送信（承認）…」「選んだ手動投稿を順に投稿…」が無い。「削除」を含まない
 * * #23 「一括投稿…」の `disabled` と出し分け（`social.approve` だけ・`social.write` だけでも出る。閲覧者には無い）
 * * #24 確認：題「一括投稿」・書き出し・内訳の行（0 件の行は無い）・手動投稿があるときだけの案内・対象外・「キャンセル」「投稿する」。時機のラジオが無い
 * * #25 「投稿する」：先頭が予約済みの手動投稿なら `open` を `apiRequest` より先に 1 回。続けて承認 → 今すぐ送る → 承認できた手動投稿ごとの取得
 * * #26 手動の対象が承認する手動投稿だけなら `open` は呼ばれず、順に投稿の 1 件目は `ready`
 * * #27 手動の対象が無く全件成功：Toast と読み込み直し。一部失敗：「一括投稿の結果」に失敗の一覧
 * * #28 承認に失敗した手動投稿は順に投稿に入らず結果の失敗に出る。取得が `ok: false` の承認済みの手動投稿は「承認しましたが…」に出る
 *
 * `SocialPending` を描画器（`test-support/hook-harness.ts`）と `renderToStaticMarkup` で描く（055・056 と同じ）。
 * テストの口 `initialBulkPost: 'confirm'`（確認を開いた状態。実装プラン §8 の 14）は型に無いので、props の型をテストに写し、
 * 指定子を `string` の定数に置いた動的 import で読む。読み込み直しは `RefreshOnMount` を葉にして描かれたかで見る。
 * 窓は `open`（`SocialPending` の差し替えの口。055）で捕まえる。`apiRequest` は道筋ごとに応答を返す偽物にする。
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
/* 型（055 設計 §9.3.5・057 実装プラン §8 の 14 から写す）                            */
/* -------------------------------------------------------------------------- */

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';

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
  readonly manualPending?: boolean;
  readonly approvedAt?: string | null;
  readonly updatedAt?: string;
  readonly source?: { readonly kind: 'screen' };
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
  readonly kind: PendingKind;
  readonly elapsedText?: string;
  readonly handoff?: ManualHandoffOutcome;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

interface PendingProps {
  readonly rows: readonly PendingRow[];
  readonly accountNames: Readonly<Record<string, string>>;
  readonly accountProviders: Readonly<
    Record<string, { readonly provider: string; readonly credentialConfigured: boolean }>
  >;
  readonly publisherProviders: Readonly<
    Record<
      string,
      {
        readonly label: string;
        readonly manual: boolean;
        readonly publish: boolean;
        readonly credentialFieldKeys: readonly string[];
      }
    >
  >;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
  readonly filters: {
    readonly status: PendingKind | null;
    readonly accountId: string | null;
    readonly source: null;
    readonly perPage: number;
    readonly sort: 'action' | 'time';
    readonly page: number;
  };
  readonly counts: Readonly<Record<PendingKind, number>>;
  readonly open?: (url: string, name: string, features: string) => unknown;
  readonly initialSelectedIds?: readonly string[];
  readonly initialBulkPost?: 'confirm';
}

type ResultItem =
  | { readonly id: string; readonly ok: true; readonly effect: BulkEffect; readonly post: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: BulkFailureReason;
      readonly message: string;
      readonly field: string | null;
    };

const MODULE: string = '@/ui/social/social-pending';

async function loadComponent(): Promise<ComponentType<PendingProps>> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  const component = module['SocialPending'];
  if (typeof component !== 'function') {
    throw new Error('ui/social/social-pending.tsx に SocialPending が無い');
  }
  return component as ComponentType<PendingProps>;
}

/* -------------------------------------------------------------------------- */
/* 文言（設計 §7.2〜§7.6）                                                        */
/* -------------------------------------------------------------------------- */

const BULK_POST_BUTTON = '一括投稿…';
const BULK_DELETE_BUTTON = '一括取り消し…';
const OLD_BULK_SEND = '一括送信（承認）';
const OLD_SEQUENCE = '選んだ手動投稿を順に投稿';
const CONFIRM_TITLE = '一括投稿';
const CONFIRM_LABEL = '投稿する';
const CANCEL_LABEL = 'キャンセル';
const RESULT_TITLE = '一括投稿の結果';
const RUNNING = '投稿しています…';
const FIRST_OPENED = '1 件目の投稿画面を開きました。';
const HANDOFF_FAILED = '承認しましたが投稿画面を開けませんでした（手動投稿待ちに残ります）';
const OPENED_GUIDE =
  'SNS の窓で投稿したら、窓を閉じてこの画面に戻ってください。戻ると記録のボタンが出ます。窓が開かないときは『別のタブで開く』を使ってください。';
const OPEN_LABEL = '投稿画面を開く';
const RECORD_NOW_LABEL = '記録へ進む';
const POSTED_LABEL = '投稿した';
const WINDOW_NAME = 'torifune-manual-post';
const WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';
const APPROVE_PATH = '/api/v1/social/posts/bulk/approve';
const PUBLISH_NOW_PATH = '/api/v1/social/posts/bulk/publish-now';

/* -------------------------------------------------------------------------- */
/* データ（表の並びの順）                                                           */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000057a1';
const ALL_PERMISSIONS = ['social.read', 'social.write', 'social.approve', 'social.delete'];

let sequence = 0;

function row(overrides: Partial<PendingRow> = {}): PendingRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000057${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `一括投稿の画面の本文 ${suffix}`,
    scheduledAt: '2026-10-30T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    approvedAt: null,
    updatedAt: `2026-10-27T00:00:00.${suffix.slice(1)}Z`,
    source: { kind: 'screen' },
    scheduledFuture: true,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    kind: 'scheduled',
    link: null,
    media: [],
    requestedAt: '2026-10-27T00:00:00.000Z',
    warning: null,
    ...overrides,
  };
}

/** 予約時刻を過ぎた手動の予約（手動投稿待ち。表の先頭）。 */
const MANUAL_PENDING = row({
  body: '予約時刻を過ぎた手動投稿',
  deliveryMode: 'manual',
  kind: 'manual_pending',
  manualPending: true,
  scheduledAt: '2026-10-26T00:00:00.000Z',
  scheduledFuture: false,
  elapsedText: '12 分',
  handoff: { ok: true, url: 'https://example.com/intent?text=pending', note: null },
});
const AWAITING_MANUAL = row({
  body: '承認待ちの手動投稿',
  status: 'awaiting_approval',
  deliveryMode: 'manual',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});
const AWAITING_AUTO = row({
  body: '承認待ちの自動投稿',
  status: 'awaiting_approval',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});
const MANUAL_FUTURE = row({
  body: '予約時刻前の手動投稿',
  deliveryMode: 'manual',
  handoff: { ok: true, url: 'https://example.com/intent?text=future', note: null },
});
const AUTO_SCHEDULED = row({ body: '自動配信の予約' });
const DUE_AUTO = row({
  body: '期限の来た自動の予約',
  scheduledAt: '2026-10-26T00:00:00.000Z',
  scheduledFuture: false,
});

const ROWS: readonly PendingRow[] = [
  MANUAL_PENDING,
  AWAITING_MANUAL,
  AWAITING_AUTO,
  MANUAL_FUTURE,
  AUTO_SCHEDULED,
  DUE_AUTO,
];

const APPROVED_URL = 'https://example.com/intent?text=approved';

const BASE: PendingProps = {
  rows: ROWS,
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  accountProviders: { [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true } },
  publisherProviders: {
    testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
  },
  total: ROWS.length,
  page: 1,
  perPage: 20,
  permissions: ALL_PERMISSIONS,
  filters: { status: null, accountId: null, source: null, perPage: 20, sort: 'action', page: 1 },
  counts: { manual_pending: 1, awaiting_approval: 2, scheduled: 3 },
};

/* -------------------------------------------------------------------------- */
/* 偽の API                                                                     */
/* -------------------------------------------------------------------------- */

/** 承認・今すぐ送るの結果の `post`（処理後の投稿。`updatedAt` は処理で変わる）。 */
function processedPost(target: PendingRow): Record<string, unknown> {
  return {
    id: target.id,
    socialAccountId: target.socialAccountId,
    body: target.body,
    status: 'scheduled',
    deliveryMode: target.deliveryMode,
    scheduledAt: '2026-10-27T03:00:00.000Z',
    updatedAt: `2026-10-27T03:00:00.${target.id.slice(-3)}Z`,
  };
}

interface FakeApi {
  /** `bulk/approve` の項目ごとの結果を差し替える（無ければ全件 `approved_now`）。 */
  approve?: (id: string) => ResultItem;
  approveRequest?: { readonly ok: false; readonly message: string };
  publishNow?: (id: string) => ResultItem;
  handoff?: (id: string) => unknown;
}

function installApi(fake: FakeApi = {}): void {
  capture.apiRequest.mockImplementation(
    async (path: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET';
      capture.log.push(`${method} ${path}`);
      const items = ((options?.body as { items?: { id: string }[] } | undefined)?.items ?? []).map(
        (item) => item.id,
      );
      const byId = (id: string): PendingRow => ROWS.find((item) => item.id === id) as PendingRow;
      if (path === APPROVE_PATH) {
        if (fake.approveRequest !== undefined) {
          return {
            ok: false,
            error: { code: 'INTERNAL', message: fake.approveRequest.message, status: 500 },
          };
        }
        return {
          ok: true,
          data: {
            results: items.map(
              (id) =>
                fake.approve?.(id) ?? {
                  id,
                  ok: true,
                  effect: 'approved_now',
                  post: processedPost(byId(id)),
                },
            ),
          },
        };
      }
      if (path === PUBLISH_NOW_PATH) {
        return {
          ok: true,
          data: {
            results: items.map(
              (id) =>
                fake.publishNow?.(id) ?? {
                  id,
                  ok: true,
                  effect: 'queued',
                  post: processedPost(byId(id)),
                },
            ),
          },
        };
      }
      const handoff = /^\/api\/v1\/social\/posts\/([^/]+)\/manual-handoff$/.exec(path);
      if (handoff !== null) {
        return (
          fake.handoff?.(handoff[1] as string) ?? {
            ok: true,
            data: { ok: true, url: APPROVED_URL, note: null },
          }
        );
      }
      return { ok: true, data: {} };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* 描画                                                                         */
/* -------------------------------------------------------------------------- */

let SocialPending: ComponentType<PendingProps>;
let RefreshOnMount: unknown;
let open: ReturnType<typeof vi.fn<(url: string, name: string, features: string) => unknown>>;

function props(overrides: Partial<PendingProps>): PendingProps {
  return { ...BASE, open, ...overrides };
}

function draw(overrides: Partial<PendingProps> = {}): readonly HostNode[] {
  return hookHarness.render(createElement(SocialPending, props(overrides)));
}

function html(overrides: Partial<PendingProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialPending, props(overrides)));
}

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 帯（と表の外）のボタンの見える文字の並び（HTML に現れる順）。 */
function buttonTexts(markup: string): string[] {
  return [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    textOf(match[1] ?? '').trim(),
  );
}

function buttonTag(markup: string, label: string): string | undefined {
  return [...markup.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/g)].find(
    (match) => textOf(match[2] ?? '').trim() === label,
  )?.[1];
}

function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|\s|>|\/)/.test(tag);
}

function dialogs(nodes: readonly HostNode[]): HostNode[] {
  return findAll(nodes, (node) => node.props['role'] === 'dialog');
}

function dialogNamed(nodes: readonly HostNode[], name: string | RegExp): HostNode | undefined {
  return dialogs(nodes).find((node) => {
    const label = String(node.props['aria-label'] ?? '');
    return typeof name === 'string' ? label === name : name.test(label);
  });
}

function only(nodes: readonly HostNode[], label: string): HostNode {
  const found = buttonsLabelled(nodes, label);
  expect(found, `「${label}」のボタン`).toHaveLength(1);
  return found[0] as HostNode;
}

function has(nodes: readonly HostNode[], label: string): boolean {
  return buttonsLabelled(nodes, label).length > 0;
}

function toastText(nodes: readonly HostNode[]): string {
  return findAll(nodes, (node) => node.props['aria-live'] === 'polite')
    .map((node) => node.text)
    .join('');
}

function reloaded(nodes: readonly HostNode[]): boolean {
  return findAll(nodes, (node) => node.type === 'leaf:RefreshOnMount').length > 0;
}

/** 選んだ行で帯の「一括投稿…」を押し、確認を開いて返す。 */
function openConfirm(selected: readonly PendingRow[]): readonly HostNode[] {
  const overrides = { initialSelectedIds: selected.map((item) => item.id) };
  click(only(draw(overrides), BULK_POST_BUTTON));
  const nodes = draw(overrides);
  expect(dialogNamed(nodes, CONFIRM_TITLE), '一括投稿の確認').toBeDefined();
  return nodes;
}

function redraw(selected: readonly PendingRow[]): readonly HostNode[] {
  return draw({ initialSelectedIds: selected.map((item) => item.id) });
}

/** 確認の「投稿する」を押す。 */
function submit(selected: readonly PendingRow[]): void {
  const dialog = dialogNamed(openConfirm(selected), CONFIRM_TITLE) as HostNode;
  click(only([dialog], CONFIRM_LABEL));
}

/** 順に投稿のダイアログ（題「手動投稿（i / n 件目）」）。表の行にも同じ名前のボタンがあるので、この中に絞る。 */
function sequenceOf(nodes: readonly HostNode[]): readonly HostNode[] {
  const dialog = dialogNamed(nodes, /^手動投稿（/);
  expect(dialog, '順に投稿のダイアログ').toBeDefined();
  return [dialog as HostNode];
}

function callsTo(path: string): unknown[][] {
  return capture.apiRequest.mock.calls.filter((call) => call[0] === path);
}

beforeEach(async () => {
  hookHarness.reset();
  hookHarness.leaves.clear();
  hookHarness.leaves.add(Link);
  RefreshOnMount = ((await import('./bulk-post-actions')) as Record<string, unknown>)[
    'RefreshOnMount'
  ];
  hookHarness.leaves.add(RefreshOnMount);
  capture.log.length = 0;
  capture.apiRequest.mockReset();
  installApi();
  open = vi.fn<(url: string, name: string, features: string) => unknown>((url: string) => {
    capture.log.push(`open ${url}`);
    return null;
  });
  SocialPending = await loadComponent();
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* #22 帯                                                                       */
/* -------------------------------------------------------------------------- */

describe('#22 送信待ちタブの一括の帯', () => {
  it('#22 「一括投稿…」「一括取り消し…」がこの順にある', () => {
    const labels = buttonTexts(html({ initialSelectedIds: [AUTO_SCHEDULED.id] }));
    const post = labels.indexOf(BULK_POST_BUTTON);
    const remove = labels.indexOf(BULK_DELETE_BUTTON);

    expect(post, BULK_POST_BUTTON).toBeGreaterThanOrEqual(0);
    expect(remove, BULK_DELETE_BUTTON).toBeGreaterThan(post);
  });

  it('#22 「一括送信（承認）…」「選んだ手動投稿を順に投稿…」が無い', () => {
    const labels = buttonTexts(html({ initialSelectedIds: [AUTO_SCHEDULED.id] }));

    expect(labels.some((label) => label.startsWith(OLD_BULK_SEND))).toBe(false);
    expect(labels.some((label) => label.startsWith(OLD_SEQUENCE))).toBe(false);
    expect(textOf(html())).not.toContain(OLD_SEQUENCE);
  });

  it('#22 帯のボタンの名前に「削除」を含まない', () => {
    const labels = buttonTexts(html({ initialSelectedIds: [AUTO_SCHEDULED.id] }));

    for (const label of [BULK_POST_BUTTON, BULK_DELETE_BUTTON]) {
      expect(
        labels.find((item) => item === label),
        label,
      ).toBeDefined();
      expect(label).not.toContain('削除');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #23 出し分けと disabled                                                       */
/* -------------------------------------------------------------------------- */

describe('#23 「一括投稿…」の出し分けと disabled', () => {
  it('#23 選択 0 件では disabled', () => {
    expect(isDisabled(buttonTag(html(), BULK_POST_BUTTON) ?? '')).toBe(true);
  });

  it('#23 対象外だけの選択（期限の来た自動の予約）では disabled', () => {
    const tag = buttonTag(html({ initialSelectedIds: [DUE_AUTO.id] }), BULK_POST_BUTTON);

    expect(tag, BULK_POST_BUTTON).toBeDefined();
    expect(isDisabled(tag ?? '')).toBe(true);
  });

  it('#23 対象を含む選択では押せる', () => {
    const tag = buttonTag(
      html({ initialSelectedIds: [DUE_AUTO.id, AUTO_SCHEDULED.id] }),
      BULK_POST_BUTTON,
    );

    expect(tag, BULK_POST_BUTTON).toBeDefined();
    expect(isDisabled(tag ?? '')).toBe(false);
  });

  it.each([
    ['social.approve だけ', ['social.read', 'social.approve']],
    ['social.write だけ', ['social.read', 'social.write']],
  ])('#23 %s でも「一括投稿…」が出る', (_label, permissions) => {
    expect(buttonTag(html({ permissions }), BULK_POST_BUTTON)).toBeDefined();
  });

  it('#23 social.approve だけの選択で承認待ちを選べば押せる', () => {
    const tag = buttonTag(
      html({
        permissions: ['social.read', 'social.approve'],
        initialSelectedIds: [AWAITING_AUTO.id],
      }),
      BULK_POST_BUTTON,
    );

    expect(tag, BULK_POST_BUTTON).toBeDefined();
    expect(isDisabled(tag ?? '')).toBe(false);
  });

  it('#23 閲覧者には「一括投稿…」が無い', () => {
    expect(buttonTag(html({ permissions: ['social.read'] }), BULK_POST_BUTTON)).toBeUndefined();
  });

  it('#23 social.delete だけ（承認も投稿も無い）には「一括投稿…」が無く「一括取り消し…」はある', () => {
    const markup = html({ permissions: ['social.read', 'social.delete'] });

    expect(buttonTag(markup, BULK_POST_BUTTON)).toBeUndefined();
    expect(buttonTag(markup, BULK_DELETE_BUTTON)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #24 確認                                                                      */
/* -------------------------------------------------------------------------- */

describe('#24 一括投稿の確認', () => {
  /** 6 件を選ぶと：今すぐ送る 1・承認 2（自動 1・手動 1）・予約済みの手動 2、対象外 1（設計 §7.3 の例）。 */
  const ALL = ROWS;

  function confirmText(): string {
    return textOfNodes([dialogNamed(openConfirm(ALL), CONFIRM_TITLE) as HostNode]);
  }

  it('#24 題が「一括投稿」の確認が開く', () => {
    expect(dialogNamed(openConfirm(ALL), CONFIRM_TITLE)).toBeDefined();
  });

  it('#24 書き出しに選んだ件数 6 と対象の件数 5', () => {
    expect(confirmText()).toMatch(/6\s*件[\s\S]*5\s*件/);
  });

  it('#24 「自動配信の予約 1 件を今すぐ送ります」', () => {
    expect(confirmText()).toContain('自動配信の予約 1 件を今すぐ送ります');
  });

  it('#24 「承認待ち 2 件を承認して投稿します（自動 1・手動 1）」', () => {
    expect(confirmText()).toContain('承認待ち 2 件を承認して投稿します（自動 1・手動 1）');
  });

  it('#24 「手動投稿 3 件を順に投稿画面で開きます」（予約済みの手動 2 ＋ 承認する手動 1）', () => {
    expect(confirmText()).toContain('手動投稿 3 件を順に投稿画面で開きます');
  });

  it('#24 対象外 1 件（配信待ち・配信中 1）', () => {
    expect(confirmText()).toMatch(/対象外\s*1\s*件（配信待ち・配信中\s*1）/);
  });

  it('#24 手動投稿があるときだけ案内（BULK_POST_MANUAL_GUIDE）を出す', async () => {
    const guide = ((await import('./labels')) as Record<string, unknown>)['BULK_POST_MANUAL_GUIDE'];

    expect(typeof guide, 'BULK_POST_MANUAL_GUIDE').toBe('string');
    expect(confirmText()).toContain(String(guide));

    hookHarness.reset();
    const autoOnly = textOfNodes([
      dialogNamed(openConfirm([AWAITING_AUTO, AUTO_SCHEDULED]), CONFIRM_TITLE) as HostNode,
    ]);
    expect(autoOnly).not.toContain(String(guide));
  });

  it('#24 0 件の行は出さない（自動だけを選べば手動投稿の行が無く、承認待ちだけなら今すぐ送るの行が無い）', () => {
    const autoOnly = textOfNodes([
      dialogNamed(openConfirm([AWAITING_AUTO]), CONFIRM_TITLE) as HostNode,
    ]);

    expect(autoOnly).toContain('承認待ち 1 件を承認して投稿します（自動 1）');
    expect(autoOnly).not.toContain('件を今すぐ送ります');
    expect(autoOnly).not.toContain('件を順に投稿画面で開きます');
    expect(autoOnly).not.toMatch(/対象外/);
  });

  it('#24 「キャンセル」「投稿する」があり、時機のラジオが無い', () => {
    const dialog = dialogNamed(openConfirm(ALL), CONFIRM_TITLE) as HostNode;

    expect(has([dialog], CANCEL_LABEL)).toBe(true);
    expect(has([dialog], CONFIRM_LABEL)).toBe(true);
    expect(
      findAll([dialog], (node) => node.type === 'input' && node.props['type'] === 'radio'),
    ).toHaveLength(0);
  });

  it('#24 テストの口 initialBulkPost: confirm で確認を開いた状態を描く（静的描画）', () => {
    const markup = html({
      initialSelectedIds: ALL.map((item) => item.id),
      initialBulkPost: 'confirm',
    });

    expect(markup).toMatch(
      /role="dialog"[^>]*aria-label="一括投稿"|aria-label="一括投稿"[^>]*role="dialog"/,
    );
    expect(textOf(markup)).toContain('手動投稿 3 件を順に投稿画面で開きます');
  });

  it('#24 確認を開いただけでは open も要求も無い', () => {
    openConfirm(ALL);

    expect(open).not.toHaveBeenCalled();
    expect(capture.apiRequest).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* #25 「投稿する」の呼び順                                                        */
/* -------------------------------------------------------------------------- */

describe('#25 「投稿する」（先頭が予約済みの手動投稿）', () => {
  it('#25 先頭の予約済みの手動投稿の URL で open が (url, 窓の名前, 開き方) で 1 回、apiRequest より先', async () => {
    submit(ROWS);
    await flush();

    expect(open.mock.calls).toEqual([
      ['https://example.com/intent?text=pending', WINDOW_NAME, WINDOW_FEATURES],
    ]);
    expect(capture.log[0]).toBe('open https://example.com/intent?text=pending');
  });

  it('#25 窓はクリックの同期処理の中で開く（要求の応答を待たない）', () => {
    submit(ROWS);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("#25 承認 → 今すぐ送る → 取得の順に送る（承認は publishTiming: 'now'）", async () => {
    submit(ROWS);
    await flush();

    expect(capture.log).toEqual([
      'open https://example.com/intent?text=pending',
      `POST ${APPROVE_PATH}`,
      `POST ${PUBLISH_NOW_PATH}`,
      `GET /api/v1/social/posts/${AWAITING_MANUAL.id}/manual-handoff`,
    ]);
  });

  it('#25 承認の本文は表の順の承認待ち（自動・手動）を 1 本で', async () => {
    submit(ROWS);
    await flush();

    expect(callsTo(APPROVE_PATH)[0]?.[1]).toEqual({
      method: 'POST',
      body: {
        publishTiming: 'now',
        items: [
          { id: AWAITING_MANUAL.id, expectedUpdatedAt: AWAITING_MANUAL.updatedAt },
          { id: AWAITING_AUTO.id, expectedUpdatedAt: AWAITING_AUTO.updatedAt },
        ],
      },
    });
  });

  it('#25 今すぐ送るの本文は自動の予約だけ（手動の予約に publish-now を掛けない）', async () => {
    submit(ROWS);
    await flush();

    expect(callsTo(PUBLISH_NOW_PATH)[0]?.[1]).toEqual({
      method: 'POST',
      body: { items: [{ id: AUTO_SCHEDULED.id, expectedUpdatedAt: AUTO_SCHEDULED.updatedAt }] },
    });
  });

  it('#25 取得は承認できた手動投稿の数だけ（自動・予約済みの手動には送らない）', async () => {
    submit(ROWS);
    await flush();

    const handoffCalls = capture.apiRequest.mock.calls.filter((call) =>
      String(call[0]).endsWith('/manual-handoff'),
    );
    expect(handoffCalls.map((call) => call[0])).toEqual([
      `/api/v1/social/posts/${AWAITING_MANUAL.id}/manual-handoff`,
    ]);
  });

  it('#25 押した直後は処理中（「投稿しています…」と「1 件目の投稿画面を開きました。」、「投稿する」は無効）', () => {
    capture.apiRequest.mockReturnValue(new Promise(() => undefined));
    submit(ROWS);
    const dialog = dialogNamed(redraw(ROWS), CONFIRM_TITLE);
    const value = textOfNodes(dialog === undefined ? redraw(ROWS) : [dialog]);

    expect(value).toContain(RUNNING);
    expect(value).toContain(FIRST_OPENED);
    for (const button of buttonsLabelled(dialogs(redraw(ROWS)), CONFIRM_LABEL)) {
      expect(button.props['disabled']).toBe(true);
    }
  });

  it('#25 終わると順に投稿の 1 件目（予約済みの手動の先頭）が opened で出る（3 件）', async () => {
    submit(ROWS);
    await flush();
    const nodes = redraw(ROWS);
    const sequenceDialog = sequenceOf(nodes);

    expect(dialogNamed(nodes, '手動投稿（1 / 3 件目）'), '順に投稿の 1 件目').toBeDefined();
    expect(textOfNodes(sequenceDialog)).toContain(MANUAL_PENDING.body);
    expect(textOfNodes(sequenceDialog)).toContain(OPENED_GUIDE);
    expect(has(sequenceDialog, POSTED_LABEL)).toBe(false);
  });

  it('#25 順に開くのは予約済みの手動（表の順）→ 承認できた手動（表の順）', async () => {
    submit(ROWS);
    await flush();
    click(only(sequenceOf(redraw(ROWS)), RECORD_NOW_LABEL));
    click(only(sequenceOf(redraw(ROWS)), POSTED_LABEL));
    await flush();

    // 2 件目（予約済みの手動の 2 つ目）を開き、記録の後に「（2 / 3 件目）」。
    expect(open.mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/intent?text=pending',
      'https://example.com/intent?text=future',
    ]);
    expect(dialogNamed(redraw(ROWS), '手動投稿（2 / 3 件目）')).toBeDefined();

    click(only(sequenceOf(redraw(ROWS)), RECORD_NOW_LABEL));
    click(only(sequenceOf(redraw(ROWS)), POSTED_LABEL));
    await flush();

    expect(open.mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/intent?text=pending',
      'https://example.com/intent?text=future',
      APPROVED_URL,
    ]);
    expect(textOfNodes(sequenceOf(redraw(ROWS)))).toContain(AWAITING_MANUAL.body);
  });
});

/* -------------------------------------------------------------------------- */
/* #26 承認する手動だけ                                                            */
/* -------------------------------------------------------------------------- */

describe('#26 手動の対象が承認する手動投稿だけ', () => {
  const SELECTED = [AWAITING_MANUAL, AWAITING_AUTO];

  it('#26 「投稿する」で open は呼ばれない', async () => {
    submit(SELECTED);
    await flush();

    expect(open).not.toHaveBeenCalled();
  });

  it('#26 承認と取得の後、順に投稿の 1 件目は ready（「投稿画面を開く」「記録へ進む」があり「投稿した」が無い）', async () => {
    submit(SELECTED);
    await flush();
    const nodes = redraw(SELECTED);
    const sequenceDialog = sequenceOf(nodes);

    expect(dialogNamed(nodes, '手動投稿（1 / 1 件目）')).toBeDefined();
    expect(has(sequenceDialog, OPEN_LABEL)).toBe(true);
    expect(has(sequenceDialog, RECORD_NOW_LABEL)).toBe(true);
    expect(has(sequenceDialog, POSTED_LABEL)).toBe(false);
    expect(textOfNodes(sequenceDialog)).not.toContain(OPENED_GUIDE);
  });

  it('#26 「投稿画面を開く」は取得した URL で開く', async () => {
    submit(SELECTED);
    await flush();
    click(only(sequenceOf(redraw(SELECTED)), OPEN_LABEL));

    expect(open.mock.calls).toEqual([[APPROVED_URL, WINDOW_NAME, WINDOW_FEATURES]]);
  });

  it('#26 記録の expectedUpdatedAt は承認の結果の post.updatedAt（行の updatedAt ではない。#36）', async () => {
    submit(SELECTED);
    await flush();
    click(only(sequenceOf(redraw(SELECTED)), RECORD_NOW_LABEL));
    click(only(sequenceOf(redraw(SELECTED)), POSTED_LABEL));
    await flush();

    const outcome = capture.apiRequest.mock.calls.find(
      (call) => call[0] === `/api/v1/social/posts/${AWAITING_MANUAL.id}/manual-outcome`,
    );
    const body = (outcome?.[1] as { body?: { expectedUpdatedAt?: string } } | undefined)?.body;

    expect(body?.expectedUpdatedAt).toBe(processedPost(AWAITING_MANUAL)['updatedAt']);
    expect(body?.expectedUpdatedAt).not.toBe(AWAITING_MANUAL.updatedAt);
  });
});

/* -------------------------------------------------------------------------- */
/* #27 手動の対象が無い                                                            */
/* -------------------------------------------------------------------------- */

describe('#27 手動の対象が無い一括投稿', () => {
  const SELECTED = [AWAITING_AUTO, AUTO_SCHEDULED];

  it('#27 全件成功：Toast「2 件を処理しました（…）」、ダイアログは閉じる', async () => {
    submit(SELECTED);
    await flush();
    const nodes = redraw(SELECTED);

    expect(toastText(nodes)).toMatch(/2\s*件を処理しました/);
    expect(dialogs(nodes)).toHaveLength(0);
  });

  it('#27 全件成功：読み込み直す', async () => {
    submit(SELECTED);
    await flush();

    expect(reloaded(redraw(SELECTED))).toBe(true);
  });

  it('#27 押す前は読み込み直していない', () => {
    openConfirm(SELECTED);

    expect(reloaded(redraw(SELECTED))).toBe(false);
  });

  it('#27 一部失敗：「一括投稿の結果」に失敗の一覧（抜粋と文言）', async () => {
    installApi({
      publishNow: (id) => ({
        id,
        ok: false,
        reason: 'stale',
        message: '内容が変わっています。',
        field: null,
      }),
    });

    submit(SELECTED);
    await flush();
    const result = dialogNamed(redraw(SELECTED), RESULT_TITLE);

    expect(result, RESULT_TITLE).toBeDefined();
    expect(textOfNodes([result as HostNode])).toContain(AUTO_SCHEDULED.body);
    expect(textOfNodes([result as HostNode])).toContain('内容が変わっています。');
  });

  it('#27 要求ごと失敗して 1 件も処理していない：Toast（サーバの文言）で、読み込み直さない', async () => {
    installApi({ approveRequest: { ok: false, message: 'サーバで失敗しました。' } });

    submit([AWAITING_AUTO]);
    await flush();
    const nodes = redraw([AWAITING_AUTO]);

    expect(toastText(nodes)).toContain('サーバで失敗しました。');
    expect(reloaded(nodes)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #28 承認・取得の失敗                                                            */
/* -------------------------------------------------------------------------- */

describe('#28 承認に失敗した手動投稿と URL の取れない手動投稿', () => {
  it('#28 承認に失敗した手動投稿は順に投稿に入らず、結果の失敗に出る（取得もしない）', async () => {
    installApi({
      approve: (id) =>
        id === AWAITING_MANUAL.id
          ? { id, ok: false, reason: 'stale', message: '内容が変わっています。', field: null }
          : {
              id,
              ok: true,
              effect: 'approved_now',
              post: processedPost(AWAITING_AUTO),
            },
    });
    const selected = [AWAITING_MANUAL, AWAITING_AUTO];

    submit(selected);
    await flush();
    const nodes = redraw(selected);
    const result = dialogNamed(nodes, RESULT_TITLE);

    expect(dialogNamed(nodes, /^手動投稿（/)).toBeUndefined();
    expect(result, RESULT_TITLE).toBeDefined();
    expect(textOfNodes([result as HostNode])).toContain(AWAITING_MANUAL.body);
    expect(
      capture.apiRequest.mock.calls.some((call) => String(call[0]).endsWith('/manual-handoff')),
    ).toBe(false);
  });

  it('#28 取得が ok: false の承認済みの手動投稿は「承認しましたが投稿画面を開けませんでした（手動投稿待ちに残ります）」に出る', async () => {
    installApi({
      handoff: () => ({ ok: true, data: { ok: false, reason: 'plugin_error' } }),
    });

    submit([AWAITING_MANUAL]);
    await flush();
    const nodes = redraw([AWAITING_MANUAL]);
    const result = dialogNamed(nodes, RESULT_TITLE);

    expect(dialogNamed(nodes, /^手動投稿（/)).toBeUndefined();
    expect(result, RESULT_TITLE).toBeDefined();
    expect(textOfNodes([result as HostNode])).toContain(HANDOFF_FAILED);
    expect(textOfNodes([result as HostNode])).toContain(AWAITING_MANUAL.body);
  });

  it('#28 取得の要求そのものが失敗しても同じく「承認しましたが…」に出る', async () => {
    installApi({
      handoff: () => ({
        ok: false,
        error: { code: 'INTERNAL', message: '通信に失敗しました。', status: 500 },
      }),
    });

    submit([AWAITING_MANUAL]);
    await flush();
    const result = dialogNamed(redraw([AWAITING_MANUAL]), RESULT_TITLE);

    expect(textOfNodes([result as HostNode])).toContain(HANDOFF_FAILED);
  });

  it('#28 URL の取れない件があっても、予約済みの手動投稿の順に投稿は続ける', async () => {
    installApi({
      handoff: () => ({ ok: true, data: { ok: false, reason: 'plugin_error' } }),
    });
    const selected = [AWAITING_MANUAL, MANUAL_FUTURE];

    submit(selected);
    await flush();

    expect(dialogNamed(redraw(selected), '手動投稿（1 / 1 件目）')).toBeDefined();
    expect(textOfNodes(sequenceOf(redraw(selected)))).toContain(MANUAL_FUTURE.body);
  });
});
