import { describe, expect, it } from 'vitest';
import type { BulkEffect, BulkFailureReason } from '@/domain/social/bulk';
import * as labels from './labels';

/**
 * 一括操作の純関数（054-bulk-post-actions 設計 §9.3〜§9.7、受け入れ条件 #65 の選択の純関数・#67・#68・#71・#72）。
 *
 * * #65：`toggleAllSelection`（未選択 → 全行、全行 → 空、一部 → 全行）と `selectionState`（`none` / `some` / `all`）
 * * #67：`sendPlanOf` が設計 §9.5 の表のとおりに承認・今すぐ送る・対象外へ分け、警告の 4 種を数える
 * * #68：`deletePlanOf` の対象・状態ごとの内訳・理由ごとの対象外
 * * #71：3 つの要求の本文（`scheduledAt` を含まない）
 * * #72：`summarizeBulkResults`（成功の件数・失敗の一覧・要求ごとの失敗の項目）
 *
 * `ui/social/bulk-plan.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （053 実装プラン §8 の 19）。口の形は 054 実装プラン §8 の 17 から写す。選択の 2 つの関数の引数は
 * §8 の 17 が決めていないので、実装プラン §8 の 51 で読んだ形（ID の集合と表示中の行）にする。
 * 行は Server Component が渡す `PostRow`（設計 §9.8 の任意の項目つき）と同じ形。
 */

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.5〜§9.8・実装プラン §8 の 17 から写す）                              */
/* -------------------------------------------------------------------------- */

interface PlanRow {
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
  readonly approvedAt?: string | null;
  readonly updatedAt?: string;
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
}

type Timing = 'now' | 'scheduled';

interface SendPlan {
  readonly approve: readonly PlanRow[];
  readonly publishNow: readonly PlanRow[];
  readonly excluded: readonly { readonly reason: string; readonly count: number }[];
  readonly warnings: {
    readonly desiredPast: number;
    readonly noDesired: number;
    readonly manualOnly: number;
    readonly manualDelivery: number;
  };
}

interface DeletePlan {
  readonly targets: readonly PlanRow[];
  readonly byStatus: {
    readonly draft: number;
    readonly awaiting_approval: number;
    readonly scheduled: number;
  };
  readonly excluded: {
    readonly published: number;
    readonly failed: number;
    readonly publishing: number;
  };
}

/** 応答の `results` の要素（設計 §8.1。`post` は応答の形の投稿）。 */
type ResultItem =
  | { readonly id: string; readonly ok: true; readonly effect: BulkEffect; readonly post: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: BulkFailureReason;
      readonly message: string;
      readonly field: string | null;
    };

interface RequestFailure {
  readonly ids: readonly string[];
  readonly message: string;
}

interface Summary {
  readonly succeeded: {
    readonly total: number;
    readonly byEffect: Readonly<Partial<Record<BulkEffect, number>>>;
  };
  readonly failures: readonly {
    readonly id: string;
    readonly excerpt: string;
    readonly reasonLabel: string;
    readonly message: string;
  }[];
}

type SelectionState = 'none' | 'some' | 'all';

interface BulkPlanModule {
  selectionState(selected: ReadonlySet<string>, rows: readonly PlanRow[]): SelectionState;
  toggleAllSelection(selected: ReadonlySet<string>, rows: readonly PlanRow[]): ReadonlySet<string>;
  sendPlanOf(
    rows: readonly PlanRow[],
    timing: Timing,
    permissions: { readonly canApprove: boolean; readonly canWrite: boolean },
  ): SendPlan;
  deletePlanOf(rows: readonly PlanRow[]): DeletePlan;
  bulkApproveRequestBody(input: {
    readonly timing: Timing;
    readonly rows: readonly PlanRow[];
  }): unknown;
  bulkPublishNowRequestBody(input: { readonly rows: readonly PlanRow[] }): unknown;
  bulkDeleteRequestBody(input: { readonly rows: readonly PlanRow[] }): unknown;
  summarizeBulkResults(
    results: readonly ResultItem[],
    rows: readonly PlanRow[],
    requestFailures?: readonly RequestFailure[],
  ): Summary;
}

const BULK_PLAN_MODULE: string = '@/ui/social/bulk-plan';

async function plan(): Promise<BulkPlanModule> {
  return (await import(/* @vite-ignore */ BULK_PLAN_MODULE)) as BulkPlanModule;
}

/** 設計 §9.10 の `BULK_REASON_LABEL`（T25 で labels.ts に足す。まだ無いので名前で引く）。 */
function reasonLabels(): Readonly<Record<string, string>> | undefined {
  return (labels as unknown as Record<string, unknown>)['BULK_REASON_LABEL'] as
    Readonly<Record<string, string>> | undefined;
}

/* -------------------------------------------------------------------------- */
/* 行                                                                          */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000054a1';

let sequence = 0;

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000054${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `投稿 ${suffix}`,
    scheduledAt: '2026-10-20T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    approvedAt: null,
    updatedAt: `2026-10-17T00:00:00.${suffix.slice(1)}Z`,
    scheduledFuture: false,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    ...overrides,
  };
}

/** 承認待ち・希望日時が未来。 */
const awaiting = (overrides: Partial<PlanRow> = {}): PlanRow =>
  row({ status: 'awaiting_approval', ...overrides });
/** 予約済み・未来（承認を経ていない）。 */
const futureScheduled = (overrides: Partial<PlanRow> = {}): PlanRow =>
  row({ status: 'scheduled', scheduledFuture: true, ...overrides });
/** 予約済み・未来・承認済み。 */
const approvedFuture = (overrides: Partial<PlanRow> = {}): PlanRow =>
  futureScheduled({ approvedAt: '2026-10-16T00:00:00.000Z', ...overrides });
/** 予約済み・期限が来ている（配信待ち・再試行待ち）。 */
const dueScheduled = (overrides: Partial<PlanRow> = {}): PlanRow =>
  row({ status: 'scheduled', scheduledAt: '2026-10-16T00:00:00.000Z', ...overrides });
/** 予約済み・配信中（auto・着手印あり）。 */
const publishingScheduled = (overrides: Partial<PlanRow> = {}): PlanRow =>
  dueScheduled({ publishing: true, ...overrides });

const ALL = { canApprove: true, canWrite: true } as const;
const WRITE_ONLY = { canApprove: false, canWrite: true } as const;
const APPROVE_ONLY = { canApprove: true, canWrite: false } as const;

function ids(rows: readonly PlanRow[]): string[] {
  return rows.map((item) => item.id);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** 対象外の理由ごとの件数（0 件の理由は数えない）。 */
function excludedCounts(sendPlan: SendPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of sendPlan.excluded) {
    if (entry.count > 0) counts[entry.reason] = (counts[entry.reason] ?? 0) + entry.count;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* #65 一括選択                                                                 */
/* -------------------------------------------------------------------------- */

describe('#65 toggleAllSelection（見出しのチェックボックスを押したとき）', () => {
  const rows = [awaiting(), futureScheduled(), row({ status: 'draft' })];

  it('#65 未選択で押すと表示中の全行が選ばれる', async () => {
    const { toggleAllSelection } = await plan();

    expect(sorted(toggleAllSelection(new Set(), rows))).toEqual(sorted(ids(rows)));
  });

  it('#65 全行を選んだ状態で押すと全部外れる', async () => {
    const { toggleAllSelection } = await plan();

    expect(sorted(toggleAllSelection(new Set(ids(rows)), rows))).toEqual([]);
  });

  it('#65 一部だけ選んだ状態で押すと全行が選ばれる', async () => {
    const { toggleAllSelection } = await plan();
    const first = rows[0] as PlanRow;

    expect(sorted(toggleAllSelection(new Set([first.id]), rows))).toEqual(sorted(ids(rows)));
  });

  it('#65 updatedAt の無い行は選ばない（expectedUpdatedAt を作れない。実装プラン §8 の 17）', async () => {
    const { toggleAllSelection } = await plan();
    const withoutUpdatedAt = row({ status: 'draft', updatedAt: undefined });

    const selected = toggleAllSelection(new Set(), [...rows, withoutUpdatedAt]);

    expect(sorted(selected)).toEqual(sorted(ids(rows)));
  });
});

describe('#65 selectionState（見出しのチェックボックスの状態）', () => {
  const rows = [awaiting(), futureScheduled(), row({ status: 'draft' })];

  it('#65 0 件選択は none（未チェック）', async () => {
    const { selectionState } = await plan();

    expect(selectionState(new Set(), rows)).toBe('none');
  });

  it('#65 全行選択は all（チェック）', async () => {
    const { selectionState } = await plan();

    expect(selectionState(new Set(ids(rows)), rows)).toBe('all');
  });

  it('#65 一部だけ選んだら some（indeterminate）', async () => {
    const { selectionState } = await plan();
    const first = rows[0] as PlanRow;

    expect(selectionState(new Set([first.id]), rows)).toBe('some');
  });
});

/* -------------------------------------------------------------------------- */
/* #67 sendPlanOf（設計 §9.5 の表）                                              */
/* -------------------------------------------------------------------------- */

type Expected = 'approve' | 'publishNow' | { readonly excluded: string };

const PERMISSION_NAMES = {
  all: ALL,
  writeOnly: WRITE_ONLY,
  approveOnly: APPROVE_ONLY,
} as const;

type PermissionName = keyof typeof PERMISSION_NAMES;

const SEND_TABLE: readonly (readonly [string, () => PlanRow, Timing, PermissionName, Expected])[] =
  [
    // 承認待ち
    ['承認待ち・canApprove', () => awaiting(), 'now', 'all', 'approve'],
    ['承認待ち・canApprove', () => awaiting(), 'scheduled', 'all', 'approve'],
    ['承認待ち・canApprove（canWrite なし）', () => awaiting(), 'now', 'approveOnly', 'approve'],
    [
      '承認待ち・canApprove でない',
      () => awaiting(),
      'now',
      'writeOnly',
      { excluded: 'no_permission' },
    ],
    [
      '承認待ち・canApprove でない',
      () => awaiting(),
      'scheduled',
      'writeOnly',
      { excluded: 'no_permission' },
    ],
    // 希望日時が過ぎている・無い承認待ちも、希望日時で「送る」（警告に数える。結果はサーバが返す）
    [
      '承認待ち・希望日時が過去',
      () => awaiting({ desiredPast: true }),
      'scheduled',
      'all',
      'approve',
    ],
    [
      '承認待ち・希望日時なし',
      () => awaiting({ scheduledAt: null }),
      'scheduled',
      'all',
      'approve',
    ],
    // 予約済み・未来・承認を経ていない
    ['予約済み・未来・canWrite', () => futureScheduled(), 'now', 'writeOnly', 'publishNow'],
    ['予約済み・未来・canWrite・canApprove', () => futureScheduled(), 'now', 'all', 'publishNow'],
    [
      '予約済み・未来・予約日時なし（scheduledFuture）',
      () => futureScheduled({ scheduledAt: null }),
      'now',
      'writeOnly',
      'publishNow',
    ],
    [
      '予約済み・未来',
      () => futureScheduled(),
      'scheduled',
      'all',
      { excluded: 'scheduled_unchanged' },
    ],
    // 予約済み・未来・承認済み
    ['承認済みの予約・canApprove', () => approvedFuture(), 'now', 'all', 'publishNow'],
    [
      '承認済みの予約・canApprove でない',
      () => approvedFuture(),
      'now',
      'writeOnly',
      { excluded: 'no_permission' },
    ],
    [
      '承認済みの予約',
      () => approvedFuture(),
      'scheduled',
      'all',
      { excluded: 'scheduled_unchanged' },
    ],
    // 予約済み・期限が来ている・配信中
    [
      '予約済み・期限が来ている',
      () => dueScheduled(),
      'now',
      'all',
      { excluded: 'due_or_publishing' },
    ],
    [
      '予約済み・期限が来ている',
      () => dueScheduled(),
      'scheduled',
      'all',
      { excluded: 'due_or_publishing' },
    ],
    [
      '予約済み・配信中',
      () => publishingScheduled(),
      'now',
      'all',
      { excluded: 'due_or_publishing' },
    ],
    [
      '予約済み・配信中',
      () => publishingScheduled(),
      'scheduled',
      'all',
      { excluded: 'due_or_publishing' },
    ],
    // 下書き・配信済み・失敗（状態の名前ごと）
    ['下書き', () => row({ status: 'draft' }), 'now', 'all', { excluded: 'draft' }],
    ['下書き', () => row({ status: 'draft' }), 'scheduled', 'all', { excluded: 'draft' }],
    ['配信済み', () => row({ status: 'published' }), 'now', 'all', { excluded: 'published' }],
    ['配信済み', () => row({ status: 'published' }), 'scheduled', 'all', { excluded: 'published' }],
    ['失敗', () => row({ status: 'failed' }), 'now', 'all', { excluded: 'failed' }],
    ['失敗', () => row({ status: 'failed' }), 'scheduled', 'all', { excluded: 'failed' }],
  ];

describe('#67 sendPlanOf の各行（設計 §9.5 の表）', () => {
  it.each(SEND_TABLE)('#67 %s × %s × %s', async (_name, make, timing, permissionName, expected) => {
    const { sendPlanOf } = await plan();
    const target = make();

    const result = sendPlanOf([target], timing, PERMISSION_NAMES[permissionName]);

    expect({
      approve: ids(result.approve),
      publishNow: ids(result.publishNow),
      excluded: excludedCounts(result),
    }).toEqual({
      approve: expected === 'approve' ? [target.id] : [],
      publishNow: expected === 'publishNow' ? [target.id] : [],
      excluded: typeof expected === 'object' ? { [expected.excluded]: 1 } : {},
    });
  });

  it('#67 複数の行を混ぜても行ごとに分かれ、対象外は理由ごとに数える', async () => {
    const { sendPlanOf } = await plan();
    const a1 = awaiting();
    const a2 = awaiting();
    const s1 = futureScheduled();
    const s2 = futureScheduled();
    const published = row({ status: 'published' });
    const due = dueScheduled();
    const draft1 = row({ status: 'draft' });
    const draft2 = row({ status: 'draft' });

    const result = sendPlanOf([a1, s1, published, a2, due, s2, draft1, draft2], 'now', ALL);

    expect(ids(result.approve)).toEqual([a1.id, a2.id]);
    expect(ids(result.publishNow)).toEqual([s1.id, s2.id]);
    expect(excludedCounts(result)).toEqual({ published: 1, due_or_publishing: 1, draft: 2 });
  });
});

describe('#67 sendPlanOf の警告の件数', () => {
  const past = awaiting({ desiredPast: true, scheduledAt: '2026-10-16T00:00:00.000Z' });
  const noDesired = awaiting({ scheduledAt: null });
  const future = awaiting();
  const manualOnly = awaiting({ manualOnly: true });
  const manualScheduled = futureScheduled({ deliveryMode: 'manual' });
  const autoScheduled = futureScheduled();
  const rows = [past, noDesired, future, manualOnly, manualScheduled, autoScheduled];

  it('#67 希望日時：希望日時を過ぎている 1・希望日時が無い 1・手動投稿のみ 1（今すぐ送るは無い）', async () => {
    const { sendPlanOf } = await plan();

    expect(sendPlanOf(rows, 'scheduled', ALL).warnings).toEqual({
      desiredPast: 1,
      noDesired: 1,
      manualOnly: 1,
      manualDelivery: 0,
    });
  });

  it('#67 即投稿：希望日時の警告は数えず、手動投稿のみ 1・今すぐ送るの手動投稿 1', async () => {
    const { sendPlanOf } = await plan();

    expect(sendPlanOf(rows, 'now', ALL).warnings).toEqual({
      desiredPast: 0,
      noDesired: 0,
      manualOnly: 1,
      manualDelivery: 1,
    });
  });

  it('#67 警告は対象の行だけで数える（承認の権限が無ければ希望日時の警告も 0）', async () => {
    const { sendPlanOf } = await plan();

    expect(sendPlanOf([past, noDesired, manualOnly], 'scheduled', WRITE_ONLY).warnings).toEqual({
      desiredPast: 0,
      noDesired: 0,
      manualOnly: 0,
      manualDelivery: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #68 deletePlanOf                                                             */
/* -------------------------------------------------------------------------- */

describe('#68 deletePlanOf', () => {
  const draft = row({ status: 'draft' });
  const waiting = awaiting();
  const scheduledAuto = futureScheduled();
  const scheduledManual = futureScheduled({ deliveryMode: 'manual' });
  const due = dueScheduled();
  const publishing = publishingScheduled();
  const published = row({ status: 'published' });
  const failed = row({ status: 'failed' });
  const rows = [draft, waiting, scheduledAuto, published, scheduledManual, publishing, due, failed];

  it('#68 下書き・承認待ち・予約済み（配信中でない。自動・手動とも）が対象', async () => {
    const { deletePlanOf } = await plan();

    expect(ids(deletePlanOf(rows).targets)).toEqual([
      draft.id,
      waiting.id,
      scheduledAuto.id,
      scheduledManual.id,
      due.id,
    ]);
  });

  it('#68 対象の状態ごとの内訳', async () => {
    const { deletePlanOf } = await plan();

    expect(deletePlanOf(rows).byStatus).toEqual({ draft: 1, awaiting_approval: 1, scheduled: 3 });
  });

  it('#68 対象外は配信済み・失敗・配信中ごとに数える', async () => {
    const { deletePlanOf } = await plan();

    expect(deletePlanOf(rows).excluded).toEqual({ published: 1, failed: 1, publishing: 1 });
  });

  it('#68 配信済みだけなら対象は 0 件', async () => {
    const { deletePlanOf } = await plan();

    const result = deletePlanOf([published, row({ status: 'published' })]);

    expect(result.targets).toEqual([]);
    expect(result.excluded).toEqual({ published: 2, failed: 0, publishing: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* #71 要求の本文                                                               */
/* -------------------------------------------------------------------------- */

describe('#71 要求の本文', () => {
  const first = awaiting({ updatedAt: '2026-10-17T01:02:03.456Z' });
  const second = awaiting({ updatedAt: '2026-10-17T01:02:04.789Z' });

  it('#71 bulkApproveRequestBody（希望日時）は publishTiming と items だけ（scheduledAt を含まない）', async () => {
    const { bulkApproveRequestBody } = await plan();

    expect(bulkApproveRequestBody({ timing: 'scheduled', rows: [first, second] })).toStrictEqual({
      publishTiming: 'scheduled',
      items: [
        { id: first.id, expectedUpdatedAt: '2026-10-17T01:02:03.456Z' },
        { id: second.id, expectedUpdatedAt: '2026-10-17T01:02:04.789Z' },
      ],
    });
  });

  it('#71 bulkApproveRequestBody（即投稿）は publishTiming: now', async () => {
    const { bulkApproveRequestBody } = await plan();

    expect(bulkApproveRequestBody({ timing: 'now', rows: [first] })).toStrictEqual({
      publishTiming: 'now',
      items: [{ id: first.id, expectedUpdatedAt: '2026-10-17T01:02:03.456Z' }],
    });
  });

  it('#71 bulkPublishNowRequestBody は items だけ', async () => {
    const { bulkPublishNowRequestBody } = await plan();
    const scheduled = futureScheduled({ updatedAt: '2026-10-17T02:00:00.001Z' });

    expect(bulkPublishNowRequestBody({ rows: [scheduled] })).toStrictEqual({
      items: [{ id: scheduled.id, expectedUpdatedAt: '2026-10-17T02:00:00.001Z' }],
    });
  });

  it('#71 bulkDeleteRequestBody は ids だけ（expectedUpdatedAt を取らない）', async () => {
    const { bulkDeleteRequestBody } = await plan();
    const draft = row({ status: 'draft' });

    expect(bulkDeleteRequestBody({ rows: [draft, first] })).toStrictEqual({
      ids: [draft.id, first.id],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #72 summarizeBulkResults                                                     */
/* -------------------------------------------------------------------------- */

const REQUEST_FAILED_LABEL = '要求が失敗しました';
const DESIRED_PASSED_MESSAGE =
  '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。';
const STALE_MESSAGE = '投稿の内容が変わっています。内容を確かめてから承認し直してください。';

function ok(id: string, effect: BulkEffect): ResultItem {
  return { id, ok: true, effect, post: null };
}

function failure(id: string, reason: BulkFailureReason, message: string): ResultItem {
  return {
    id,
    ok: false,
    reason,
    message,
    field: reason === 'desired_time_passed' ? 'scheduledAt' : null,
  };
}

describe('#72 summarizeBulkResults', () => {
  const r1 = awaiting({ body: '新製品のお知らせ' });
  const r2 = awaiting({ body: '秋のセールの告知' });
  const r3 = futureScheduled({ body: '週末のイベント' });
  const r4 = futureScheduled({ body: '年末のご挨拶' });
  const rows = [r1, r2, r3, r4];

  it('#72 全件成功：失敗の一覧は空で、成功の件数を effect ごとに数える', async () => {
    const { summarizeBulkResults } = await plan();

    const summary = summarizeBulkResults(
      [ok(r1.id, 'approved_now'), ok(r2.id, 'approved_now'), ok(r3.id, 'queued')],
      rows,
    );

    expect(summary.failures).toEqual([]);
    expect(summary.succeeded.total).toBe(3);
    expect(summary.succeeded.byEffect['approved_now']).toBe(2);
    expect(summary.succeeded.byEffect['queued']).toBe(1);
    expect(summary.succeeded.byEffect['manual_pending'] ?? 0).toBe(0);
  });

  it('#72 失敗あり：行の本文の抜粋・BULK_REASON_LABEL・message を結果の順に並べる', async () => {
    const { summarizeBulkResults } = await plan();
    const reasonLabel = reasonLabels();

    const summary = summarizeBulkResults(
      [
        ok(r1.id, 'approved_now'),
        failure(r2.id, 'desired_time_passed', DESIRED_PASSED_MESSAGE),
        failure(r3.id, 'stale', STALE_MESSAGE),
      ],
      rows,
    );

    expect(reasonLabel, 'labels.ts の BULK_REASON_LABEL').toBeDefined();
    expect(summary.succeeded.total).toBe(1);
    expect(summary.failures.map((item) => item.id)).toEqual([r2.id, r3.id]);
    expect(summary.failures[0]).toMatchObject({
      reasonLabel: reasonLabel?.['desired_time_passed'],
      message: DESIRED_PASSED_MESSAGE,
    });
    expect(summary.failures[0]?.excerpt).toContain('秋のセールの告知');
    expect(summary.failures[1]).toMatchObject({
      reasonLabel: reasonLabel?.['stale'],
      message: STALE_MESSAGE,
    });
    expect(summary.failures[1]?.excerpt).toContain('週末のイベント');
  });

  it('#72 要求ごとの失敗の項目も「要求が失敗しました」で一覧に入る（1 本目の結果は捨てない）', async () => {
    const { summarizeBulkResults } = await plan();
    const message = '操作の回数が多すぎます。しばらく待ってからやり直してください。';

    const summary = summarizeBulkResults(
      [ok(r1.id, 'approved_now'), ok(r2.id, 'approved_now')],
      rows,
      [{ ids: [r3.id, r4.id], message }],
    );

    expect(summary.succeeded.total).toBe(2);
    expect(summary.failures.map((item) => item.id)).toEqual([r3.id, r4.id]);
    for (const item of summary.failures) {
      expect(item.reasonLabel).toContain(REQUEST_FAILED_LABEL);
      expect(item.message).toBe(message);
    }
    expect(summary.failures[0]?.excerpt).toContain('週末のイベント');
    expect(summary.failures[1]?.excerpt).toContain('年末のご挨拶');
  });

  it('#72 requestFailures を渡さなければ要求ごとの失敗は無い（既定は空）', async () => {
    const { summarizeBulkResults } = await plan();

    expect(summarizeBulkResults([ok(r1.id, 'deleted')], rows).failures).toEqual([]);
  });
});
