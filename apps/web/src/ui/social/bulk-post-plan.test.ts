import { describe, expect, it } from 'vitest';
import type { BulkEffect, BulkFailureReason } from '@/domain/social/bulk';

/**
 * 一括投稿の純関数（057-social-bulk-post 設計 §5.2・§5.3・§7.4・§7.5、受け入れ条件 #13〜#20）。
 *
 * * #13〜#17 `bulkPostPlanOf(selectedRows, { canApprove, canWrite })`：設計 §5.2 の表のとおりに振り分ける
 * * #18 `bulkPostApproveRequestBody(rows)`：`{ publishTiming: 'now', items: [{ id, expectedUpdatedAt }] }`
 * * #19 `approvedManualTargetsOf(results, rows, handoffs)`：承認できた手動投稿の順に投稿の対象と、URL の取れなかった件
 * * #20 `bulkPostOutcomeOf(...)`：終わりの表示の要約と「閉じた後に読み込み直すか」
 *
 * 戻り値の形は設計が名前（`approve`・`publishNow`・`manual`・対象外）しか決めていないので、本テストで読んだ形を
 * 実装プラン §8 の 18 に記録した。`ui/social/bulk-post-plan.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む。
 * 行の型は `social-pending.test.ts` の `row()` の形（055 設計 §9.3.5 の `PendingRow`）を写す。
 */

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
  readonly approvedAt?: string | null;
  readonly updatedAt?: string;
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
  readonly kind: PendingKind;
  readonly handoff?: ManualHandoffOutcome;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

type ExcludedReason =
  'no_approve_permission' | 'no_write_permission' | 'due_or_publishing' | 'handoff_unavailable';

interface BulkPostPlan {
  readonly approve: readonly PendingRow[];
  readonly publishNow: readonly PendingRow[];
  readonly manual: readonly PendingRow[];
  readonly excluded: readonly { readonly reason: ExcludedReason; readonly count: number }[];
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

interface ManualSequenceTarget {
  readonly id: string;
  readonly body: string;
  readonly socialAccountId: string;
  readonly scheduledAt: string | null;
  readonly updatedAt: string;
  readonly url: string;
  readonly note: string | null;
}

interface ApprovedManualTargets {
  readonly targets: readonly ManualSequenceTarget[];
  readonly handoffFailed: readonly { readonly id: string; readonly excerpt: string }[];
}

interface SequenceRecord {
  readonly id: string;
  readonly outcome: 'posted' | 'not_posted' | 'skipped';
}

interface OutcomeInput {
  readonly results: readonly ResultItem[];
  readonly requestFailures: readonly {
    readonly ids: readonly string[];
    readonly message: string;
  }[];
  readonly rows: readonly PendingRow[];
  readonly records: readonly SequenceRecord[];
  readonly sequenceTotal: number;
  readonly handoffFailed: readonly { readonly id: string; readonly excerpt: string }[];
}

interface BulkPostOutcome {
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
  readonly manual: {
    readonly posted: number;
    readonly notPosted: number;
    readonly skipped: number;
  };
  readonly unrecorded: number;
  readonly handoffFailed: readonly { readonly id: string; readonly excerpt: string }[];
  readonly reload: boolean;
}

interface BulkPostPlanModule {
  readonly bulkPostPlanOf: (
    rows: readonly PendingRow[],
    permissions: { readonly canApprove: boolean; readonly canWrite: boolean },
  ) => BulkPostPlan;
  readonly bulkPostApproveRequestBody: (rows: readonly PendingRow[]) => unknown;
  readonly approvedManualTargetsOf: (
    results: readonly ResultItem[],
    rows: readonly PendingRow[],
    handoffs: Readonly<Record<string, ManualHandoffOutcome | null>>,
  ) => ApprovedManualTargets;
  readonly bulkPostOutcomeOf: (input: OutcomeInput) => BulkPostOutcome;
  readonly BULK_POST_EXCLUDED_REASONS: readonly string[];
}

const MODULE: string = '@/ui/social/bulk-post-plan';

async function load(): Promise<BulkPostPlanModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  for (const name of [
    'bulkPostPlanOf',
    'bulkPostApproveRequestBody',
    'approvedManualTargetsOf',
    'bulkPostOutcomeOf',
  ]) {
    if (typeof module[name] !== 'function') {
      throw new Error(`ui/social/bulk-post-plan.ts に ${name} が無い`);
    }
  }
  return module as unknown as BulkPostPlanModule;
}

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000057a1';

let sequence = 0;

function row(overrides: Partial<PendingRow> = {}): PendingRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000057${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `一括投稿の本文 ${suffix}`,
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

function handoffOk(label: string): ManualHandoffOutcome {
  return { ok: true, url: `https://example.com/intent?text=${label}`, note: null };
}

const AWAITING_AUTO = row({
  body: '承認待ちの自動',
  status: 'awaiting_approval',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});
const AWAITING_MANUAL = row({
  body: '承認待ちの手動',
  status: 'awaiting_approval',
  deliveryMode: 'manual',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});
const FUTURE_AUTO = row({ body: '未来の自動の予約' });
const FUTURE_AUTO_APPROVED = row({
  body: '承認済みの未来の自動の予約',
  approvedAt: '2026-10-26T00:00:00.000Z',
});
const NO_DATE_AUTO = row({ body: '予約日時の無い自動の予約', scheduledAt: null });
const DUE_AUTO = row({
  body: '期限の来た自動の予約',
  scheduledAt: '2026-10-26T00:00:00.000Z',
  scheduledFuture: false,
});
const PUBLISHING_AUTO = row({
  body: '配信中の自動の予約',
  scheduledAt: '2026-10-26T00:00:00.000Z',
  scheduledFuture: false,
  publishing: true,
});
const MANUAL_FUTURE = row({
  body: '予約時刻前の手動の予約',
  deliveryMode: 'manual',
  handoff: handoffOk('future'),
});
const MANUAL_PAST = row({
  body: '予約時刻を過ぎた手動の予約',
  deliveryMode: 'manual',
  kind: 'manual_pending',
  scheduledAt: '2026-10-26T00:00:00.000Z',
  scheduledFuture: false,
  handoff: handoffOk('past'),
});
const MANUAL_APPROVED = row({
  body: '承認済みの手動の予約',
  deliveryMode: 'manual',
  approvedAt: '2026-10-26T00:00:00.000Z',
  handoff: handoffOk('approved'),
});
const MANUAL_UNAVAILABLE = row({
  body: '開けない手動の予約',
  deliveryMode: 'manual',
  handoff: { ok: false, reason: 'plugin_error' },
});
const MANUAL_NO_HANDOFF = row({ body: 'handoff の無い手動の予約', deliveryMode: 'manual' });

const ADMIN = { canApprove: true, canWrite: true } as const;

function ids(rows: readonly PendingRow[]): string[] {
  return rows.map((item) => item.id);
}

function excludedOf(plan: BulkPostPlan): Record<string, number> {
  return Object.fromEntries(plan.excluded.map((item) => [item.reason, item.count]));
}

/** 1 行だけ渡したときにどこへ振り分けられたか。 */
function placeOf(plan: BulkPostPlan): string {
  if (plan.approve.length === 1) return 'approve';
  if (plan.publishNow.length === 1) return 'publishNow';
  if (plan.manual.length === 1) return 'manual';
  if (plan.excluded.length === 1 && plan.excluded[0]?.count === 1) {
    return `excluded:${plan.excluded[0].reason}`;
  }
  return `?${JSON.stringify(plan)}`;
}

/* -------------------------------------------------------------------------- */
/* #13 管理者                                                                    */
/* -------------------------------------------------------------------------- */

describe('#13 bulkPostPlanOf（管理者：canApprove・canWrite）', () => {
  it.each([
    ['承認待ちの自動', AWAITING_AUTO, 'approve'],
    ['承認待ちの手動', AWAITING_MANUAL, 'approve'],
    ['未来の自動の予約', FUTURE_AUTO, 'publishNow'],
    ['承認済みの未来の自動の予約', FUTURE_AUTO_APPROVED, 'publishNow'],
    ['予約日時の無い自動の予約', NO_DATE_AUTO, 'publishNow'],
    ['期限の来た自動の予約', DUE_AUTO, 'excluded:due_or_publishing'],
    ['配信中の自動の予約', PUBLISHING_AUTO, 'excluded:due_or_publishing'],
    ['予約時刻前の手動の予約', MANUAL_FUTURE, 'manual'],
    ['予約時刻を過ぎた手動の予約', MANUAL_PAST, 'manual'],
    ['承認済みの手動の予約', MANUAL_APPROVED, 'manual'],
    ['開けない手動の予約', MANUAL_UNAVAILABLE, 'excluded:handoff_unavailable'],
    ['handoff の無い手動の予約', MANUAL_NO_HANDOFF, 'excluded:handoff_unavailable'],
  ] as const)('#13 %s → %s', async (_label, target, place) => {
    const { bulkPostPlanOf } = await load();

    expect(placeOf(bulkPostPlanOf([target], ADMIN))).toBe(place);
  });

  it('#13 配信中は予約日時が未来でも due_or_publishing（publishing を先に見る）', async () => {
    const { bulkPostPlanOf } = await load();
    const publishingFuture = row({ body: '未来なのに配信中', publishing: true });

    expect(placeOf(bulkPostPlanOf([publishingFuture], ADMIN))).toBe('excluded:due_or_publishing');
  });

  it('#13 手動の予約は今すぐ送るに回さない（publishNow に入らない）', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf([MANUAL_FUTURE, MANUAL_PAST, MANUAL_APPROVED], ADMIN);

    expect(plan.publishNow).toEqual([]);
    expect(ids(plan.manual)).toEqual(ids([MANUAL_FUTURE, MANUAL_PAST, MANUAL_APPROVED]));
  });

  it('#13 送信待ちの区分でない行（下書き・配信済み・失敗）は数えずに捨てる', async () => {
    const { bulkPostPlanOf } = await load();
    const others = [
      row({ body: '下書き', status: 'draft', scheduledFuture: false }),
      row({ body: '配信済み', status: 'published', scheduledFuture: false }),
      row({ body: '失敗', status: 'failed', scheduledFuture: false }),
    ];

    const plan = bulkPostPlanOf(others, ADMIN);

    expect(plan).toEqual({ approve: [], publishNow: [], manual: [], excluded: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* #14 canApprove なし                                                           */
/* -------------------------------------------------------------------------- */

describe('#14 bulkPostPlanOf（canApprove が無い）', () => {
  const WRITER = { canApprove: false, canWrite: true } as const;

  it.each([
    ['承認待ちの自動', AWAITING_AUTO, 'excluded:no_approve_permission'],
    ['承認待ちの手動', AWAITING_MANUAL, 'excluded:no_approve_permission'],
    ['承認済みの未来の自動の予約', FUTURE_AUTO_APPROVED, 'excluded:no_approve_permission'],
    ['未承認の未来の自動の予約', FUTURE_AUTO, 'publishNow'],
    ['予約日時の無い未承認の自動の予約', NO_DATE_AUTO, 'publishNow'],
    ['予約時刻前の手動の予約', MANUAL_FUTURE, 'manual'],
    ['予約時刻を過ぎた手動の予約', MANUAL_PAST, 'manual'],
    ['承認済みの手動の予約', MANUAL_APPROVED, 'manual'],
  ] as const)('#14 %s → %s', async (_label, target, place) => {
    const { bulkPostPlanOf } = await load();

    expect(placeOf(bulkPostPlanOf([target], WRITER))).toBe(place);
  });
});

/* -------------------------------------------------------------------------- */
/* #15 canWrite なし                                                             */
/* -------------------------------------------------------------------------- */

describe('#15 bulkPostPlanOf（canWrite が無い。canApprove だけ）', () => {
  const APPROVER = { canApprove: true, canWrite: false } as const;

  it.each([
    ['承認待ちの自動', AWAITING_AUTO, 'approve'],
    ['承認待ちの手動', AWAITING_MANUAL, 'excluded:no_write_permission'],
    ['未来の自動の予約', FUTURE_AUTO, 'excluded:no_write_permission'],
    ['承認済みの未来の自動の予約', FUTURE_AUTO_APPROVED, 'excluded:no_write_permission'],
    ['予約時刻前の手動の予約', MANUAL_FUTURE, 'excluded:no_write_permission'],
    ['予約時刻を過ぎた手動の予約', MANUAL_PAST, 'excluded:no_write_permission'],
    ['開けない手動の予約', MANUAL_UNAVAILABLE, 'excluded:no_write_permission'],
  ] as const)('#15 %s → %s', async (_label, target, place) => {
    const { bulkPostPlanOf } = await load();

    expect(placeOf(bulkPostPlanOf([target], APPROVER))).toBe(place);
  });

  it('#15 期限の来た自動の予約は権限に依らず due_or_publishing（設計 §5.2 の表の「—」）', async () => {
    const { bulkPostPlanOf } = await load();

    expect(placeOf(bulkPostPlanOf([DUE_AUTO], APPROVER))).toBe('excluded:due_or_publishing');
  });
});

/* -------------------------------------------------------------------------- */
/* #16 並び                                                                     */
/* -------------------------------------------------------------------------- */

describe('#16 並びは渡した順', () => {
  it('#16 manual は渡した順の予約済みの手動', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf(
      [MANUAL_APPROVED, FUTURE_AUTO, MANUAL_PAST, AWAITING_AUTO, MANUAL_FUTURE],
      ADMIN,
    );

    expect(ids(plan.manual)).toEqual(ids([MANUAL_APPROVED, MANUAL_PAST, MANUAL_FUTURE]));
  });

  it('#16 approve は自動・手動を渡した順のまま 1 つの列（承認する手動も approve の中に渡した順）', async () => {
    const { bulkPostPlanOf } = await load();
    const awaitingManual2 = row({
      body: '承認待ちの手動 2',
      status: 'awaiting_approval',
      deliveryMode: 'manual',
      kind: 'awaiting_approval',
      scheduledFuture: false,
    });

    const plan = bulkPostPlanOf(
      [awaitingManual2, MANUAL_FUTURE, AWAITING_AUTO, FUTURE_AUTO, AWAITING_MANUAL],
      ADMIN,
    );

    expect(ids(plan.approve)).toEqual(ids([awaitingManual2, AWAITING_AUTO, AWAITING_MANUAL]));
    expect(ids(plan.manual)).toEqual(ids([MANUAL_FUTURE]));
  });

  it('#16 publishNow は渡した順', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf(
      [NO_DATE_AUTO, MANUAL_FUTURE, FUTURE_AUTO_APPROVED, FUTURE_AUTO],
      ADMIN,
    );

    expect(ids(plan.publishNow)).toEqual(ids([NO_DATE_AUTO, FUTURE_AUTO_APPROVED, FUTURE_AUTO]));
  });

  it('#16 承認待ちの手動は manual に入らない（approve の中だけ）', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf([AWAITING_MANUAL, MANUAL_FUTURE], ADMIN);

    expect(ids(plan.manual)).not.toContain(AWAITING_MANUAL.id);
    expect(ids(plan.approve)).toEqual([AWAITING_MANUAL.id]);
  });
});

/* -------------------------------------------------------------------------- */
/* #17 対象外の件数と並び                                                          */
/* -------------------------------------------------------------------------- */

describe('#17 対象外は理由ごとの件数で、決まった並び', () => {
  it('#17 canApprove が無い：no_approve_permission → due_or_publishing → handoff_unavailable（渡した順に依らない）', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf(
      [
        MANUAL_UNAVAILABLE,
        DUE_AUTO,
        AWAITING_AUTO,
        PUBLISHING_AUTO,
        AWAITING_MANUAL,
        MANUAL_NO_HANDOFF,
      ],
      { canApprove: false, canWrite: true },
    );

    expect(plan.excluded).toEqual([
      { reason: 'no_approve_permission', count: 2 },
      { reason: 'due_or_publishing', count: 2 },
      { reason: 'handoff_unavailable', count: 2 },
    ]);
  });

  it('#17 canWrite が無い：no_write_permission → due_or_publishing', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf([DUE_AUTO, FUTURE_AUTO, MANUAL_FUTURE], {
      canApprove: true,
      canWrite: false,
    });

    expect(plan.excluded).toEqual([
      { reason: 'no_write_permission', count: 2 },
      { reason: 'due_or_publishing', count: 1 },
    ]);
  });

  it('#17 どちらも無い：no_approve_permission → no_write_permission → due_or_publishing', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf([DUE_AUTO, FUTURE_AUTO, AWAITING_AUTO], {
      canApprove: false,
      canWrite: false,
    });

    expect(plan.excluded).toEqual([
      { reason: 'no_approve_permission', count: 1 },
      { reason: 'no_write_permission', count: 1 },
      { reason: 'due_or_publishing', count: 1 },
    ]);
  });

  it('#17 0 件の理由を含めない', async () => {
    const { bulkPostPlanOf } = await load();

    const plan = bulkPostPlanOf([DUE_AUTO, FUTURE_AUTO], ADMIN);

    expect(plan.excluded).toEqual([{ reason: 'due_or_publishing', count: 1 }]);
    expect(excludedOf(plan)).not.toHaveProperty('handoff_unavailable');
  });

  it('#17 選択 0 件 → 対象も対象外も 0', async () => {
    const { bulkPostPlanOf } = await load();

    expect(bulkPostPlanOf([], ADMIN)).toEqual({
      approve: [],
      publishNow: [],
      manual: [],
      excluded: [],
    });
  });

  it('#17 理由の定数 BULK_POST_EXCLUDED_REASONS が設計 §5.2 の 4 つをこの順で持つ', async () => {
    const { BULK_POST_EXCLUDED_REASONS } = await load();

    expect(BULK_POST_EXCLUDED_REASONS).toEqual([
      'no_approve_permission',
      'no_write_permission',
      'due_or_publishing',
      'handoff_unavailable',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #18 承認の本文                                                                 */
/* -------------------------------------------------------------------------- */

describe('#18 bulkPostApproveRequestBody', () => {
  it("#18 { publishTiming: 'now', items: [{ id, expectedUpdatedAt: row.updatedAt }] }（渡した順）", async () => {
    const { bulkPostApproveRequestBody } = await load();

    expect(bulkPostApproveRequestBody([AWAITING_MANUAL, AWAITING_AUTO])).toEqual({
      publishTiming: 'now',
      items: [
        { id: AWAITING_MANUAL.id, expectedUpdatedAt: AWAITING_MANUAL.updatedAt },
        { id: AWAITING_AUTO.id, expectedUpdatedAt: AWAITING_AUTO.updatedAt },
      ],
    });
  });

  it('#18 時機は常に now（希望日時の時機を送らない）', async () => {
    const { bulkPostApproveRequestBody } = await load();
    const desired = row({
      body: '希望日時のある承認待ち',
      status: 'awaiting_approval',
      kind: 'awaiting_approval',
      scheduledAt: '2026-11-01T00:00:00.000Z',
    });

    expect(bulkPostApproveRequestBody([desired])).toMatchObject({ publishTiming: 'now' });
  });
});

/* -------------------------------------------------------------------------- */
/* #19 承認した手動の対象                                                          */
/* -------------------------------------------------------------------------- */

describe('#19 approvedManualTargetsOf', () => {
  const MANUAL_2 = row({
    body: '承認待ちの手動その 2',
    status: 'awaiting_approval',
    deliveryMode: 'manual',
    kind: 'awaiting_approval',
    scheduledFuture: false,
  });
  const MANUAL_3 = row({
    body: '承認待ちの手動その 3',
    status: 'awaiting_approval',
    deliveryMode: 'manual',
    kind: 'awaiting_approval',
    scheduledFuture: false,
  });
  const ROWS = [AWAITING_MANUAL, AWAITING_AUTO, MANUAL_2, MANUAL_3];

  /** 承認の結果の `post`（処理後の投稿。`updatedAt`・`scheduledAt` は承認で変わる）。 */
  function approvedPost(target: PendingRow, minute: number): Record<string, unknown> {
    return {
      id: target.id,
      socialAccountId: target.socialAccountId,
      body: target.body,
      status: 'scheduled',
      deliveryMode: target.deliveryMode,
      scheduledAt: `2026-10-27T01:0${minute}:00.000Z`,
      updatedAt: `2026-10-27T01:0${minute}:00.789Z`,
    };
  }

  function ok(target: PendingRow, minute: number): ResultItem {
    return { id: target.id, ok: true, effect: 'approved_now', post: approvedPost(target, minute) };
  }

  const STALE: ResultItem = {
    id: MANUAL_3.id,
    ok: false,
    reason: 'stale',
    message: '内容が変わっています。',
    field: null,
  };

  it('#19 ok の結果で行が手動のものだけが対象（自動・ok: false は含めない）', async () => {
    const { approvedManualTargetsOf } = await load();

    const out = approvedManualTargetsOf(
      [ok(AWAITING_MANUAL, 1), ok(AWAITING_AUTO, 2), ok(MANUAL_2, 3), STALE],
      ROWS,
      {
        [AWAITING_MANUAL.id]: handoffOk('a'),
        [MANUAL_2.id]: handoffOk('b'),
        [MANUAL_3.id]: handoffOk('c'),
      },
    );

    expect(out.targets.map((target) => target.id)).toEqual([AWAITING_MANUAL.id, MANUAL_2.id]);
  });

  it('#19 updatedAt・scheduledAt は結果の post の値（行の値ではない）', async () => {
    const { approvedManualTargetsOf } = await load();

    const out = approvedManualTargetsOf([ok(AWAITING_MANUAL, 4)], ROWS, {
      [AWAITING_MANUAL.id]: handoffOk('a'),
    });
    const target = out.targets[0];

    expect(target?.updatedAt).toBe('2026-10-27T01:04:00.789Z');
    expect(target?.updatedAt).not.toBe(AWAITING_MANUAL.updatedAt);
    expect(target?.scheduledAt).toBe('2026-10-27T01:04:00.000Z');
  });

  it('#19 対象は id・body・socialAccountId・scheduledAt・updatedAt・url・note を持つ（url・note は handoff の値）', async () => {
    const { approvedManualTargetsOf } = await load();

    const out = approvedManualTargetsOf([ok(AWAITING_MANUAL, 5)], ROWS, {
      [AWAITING_MANUAL.id]: { ok: true, url: 'https://example.com/intent?text=n', note: '注意' },
    });

    expect(out.targets).toEqual([
      {
        id: AWAITING_MANUAL.id,
        body: AWAITING_MANUAL.body,
        socialAccountId: AWAITING_MANUAL.socialAccountId,
        scheduledAt: '2026-10-27T01:05:00.000Z',
        updatedAt: '2026-10-27T01:05:00.789Z',
        url: 'https://example.com/intent?text=n',
        note: '注意',
      },
    ]);
    expect(out.handoffFailed).toEqual([]);
  });

  it('#19 handoff が ok: false・取れなかった（null・無い）ものは対象にせず「URL の取れなかった件」に（渡した順）', async () => {
    const { approvedManualTargetsOf } = await load();

    const out = approvedManualTargetsOf(
      [ok(AWAITING_MANUAL, 1), ok(MANUAL_2, 2), ok(MANUAL_3, 3)],
      ROWS,
      {
        [AWAITING_MANUAL.id]: { ok: false, reason: 'plugin_error' },
        [MANUAL_2.id]: null,
      },
    );

    expect(out.targets).toEqual([]);
    expect(out.handoffFailed.map((item) => item.id)).toEqual([
      AWAITING_MANUAL.id,
      MANUAL_2.id,
      MANUAL_3.id,
    ]);
  });

  it('#19 URL の取れなかった件は本文の抜粋を持つ', async () => {
    const { approvedManualTargetsOf } = await load();

    const out = approvedManualTargetsOf([ok(AWAITING_MANUAL, 1)], ROWS, {
      [AWAITING_MANUAL.id]: null,
    });

    expect(out.handoffFailed).toEqual([{ id: AWAITING_MANUAL.id, excerpt: AWAITING_MANUAL.body }]);
  });

  it('#19 承認に失敗した手動・自動の行は URL の取れなかった件にも入れない', async () => {
    const { approvedManualTargetsOf } = await load();

    const out = approvedManualTargetsOf([ok(AWAITING_AUTO, 1), STALE], ROWS, {});

    expect(out).toEqual({ targets: [], handoffFailed: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* #20 終わりの表示の要約                                                          */
/* -------------------------------------------------------------------------- */

describe('#20 bulkPostOutcomeOf', () => {
  const FAILED: ResultItem = {
    id: FUTURE_AUTO.id,
    ok: false,
    reason: 'stale',
    message: '内容が変わっています。',
    field: null,
  };
  const APPROVED: ResultItem = {
    id: AWAITING_AUTO.id,
    ok: true,
    effect: 'approved_now',
    post: null,
  };
  const PUBLISHED_NOW: ResultItem = {
    id: NO_DATE_AUTO.id,
    ok: true,
    effect: 'queued',
    post: null,
  };
  const ROWS = [
    AWAITING_AUTO,
    FUTURE_AUTO,
    NO_DATE_AUTO,
    MANUAL_FUTURE,
    MANUAL_PAST,
    MANUAL_APPROVED,
  ];

  function input(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
    return {
      results: [],
      requestFailures: [],
      rows: ROWS,
      records: [],
      sequenceTotal: 0,
      handoffFailed: [],
      ...overrides,
    };
  }

  it('#20 1 段目の成功の内訳は summarizeBulkResults と同じ（total・byEffect）', async () => {
    const { bulkPostOutcomeOf } = await load();

    const out = bulkPostOutcomeOf(input({ results: [APPROVED, FAILED] }));

    expect(out.succeeded).toEqual({ total: 1, byEffect: { approved_now: 1 } });
  });

  it('#20 失敗の一覧は項目ごとの失敗と要求ごとの失敗（抜粋・理由・文言）', async () => {
    const { bulkPostOutcomeOf } = await load();

    const out = bulkPostOutcomeOf(
      input({
        results: [FAILED],
        requestFailures: [{ ids: [NO_DATE_AUTO.id], message: '通信に失敗しました。' }],
      }),
    );

    expect(out.failures.map((failure) => [failure.id, failure.excerpt, failure.message])).toEqual([
      [FUTURE_AUTO.id, FUTURE_AUTO.body, '内容が変わっています。'],
      [NO_DATE_AUTO.id, NO_DATE_AUTO.body, '通信に失敗しました。'],
    ]);
    for (const failure of out.failures) {
      expect(failure.reasonLabel, failure.id).not.toBe('');
    }
  });

  it('#20 記録の件数（投稿した・投稿しなかった・飛ばした）', async () => {
    const { bulkPostOutcomeOf } = await load();

    const out = bulkPostOutcomeOf(
      input({
        records: [
          { id: MANUAL_FUTURE.id, outcome: 'posted' },
          { id: MANUAL_PAST.id, outcome: 'skipped' },
          { id: MANUAL_APPROVED.id, outcome: 'not_posted' },
        ],
        sequenceTotal: 3,
      }),
    );

    expect(out.manual).toEqual({ posted: 1, notPosted: 1, skipped: 1 });
    expect(out.unrecorded).toBe(0);
  });

  it('#20 記録していない件数＝順に投稿の対象の数 − 記録した数（途中でやめた）', async () => {
    const { bulkPostOutcomeOf } = await load();

    const out = bulkPostOutcomeOf(
      input({ records: [{ id: MANUAL_FUTURE.id, outcome: 'posted' }], sequenceTotal: 3 }),
    );

    expect(out.unrecorded).toBe(2);
  });

  it('#20 URL の取れなかった件はそのまま返す', async () => {
    const { bulkPostOutcomeOf } = await load();
    const handoffFailed = [{ id: AWAITING_MANUAL.id, excerpt: AWAITING_MANUAL.body }];

    expect(bulkPostOutcomeOf(input({ handoffFailed })).handoffFailed).toEqual(handoffFailed);
  });

  it.each([
    ['1 段目の成功が 1 件', { results: [APPROVED] }, true],
    ['今すぐ送るの成功だけ', { results: [PUBLISHED_NOW] }, true],
    [
      '「投稿した」が 1 件',
      { records: [{ id: MANUAL_FUTURE.id, outcome: 'posted' }], sequenceTotal: 1 },
      true,
    ],
    [
      '「投稿しなかった」が 1 件',
      { records: [{ id: MANUAL_FUTURE.id, outcome: 'not_posted' }], sequenceTotal: 1 },
      true,
    ],
    [
      '飛ばしただけ',
      { records: [{ id: MANUAL_FUTURE.id, outcome: 'skipped' }], sequenceTotal: 1 },
      false,
    ],
    ['1 段目がすべて失敗', { results: [FAILED] }, false],
    [
      '要求ごとの失敗だけ',
      { requestFailures: [{ ids: [FUTURE_AUTO.id], message: '失敗' }] },
      false,
    ],
    ['何もしていない（やめただけ）', { sequenceTotal: 2 }, false],
  ] as const)('#20 読み込み直すか：%s → %s', async (_label, overrides, expected) => {
    const { bulkPostOutcomeOf } = await load();

    expect(bulkPostOutcomeOf(input(overrides as Partial<OutcomeInput>)).reload).toBe(expected);
  });
});
