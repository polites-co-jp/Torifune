import { describe, expect, it } from 'vitest';

/**
 * 送信待ちの区分・並び順・手動投稿の結果の判定（055-social-pending-tab 設計 §5.2・§5.3・§5.5・§5.6・§6、
 * 受け入れ条件 #1〜#5、#76 の Domain 側）。
 *
 * **Domain 層の単体テスト。** DB も Plugin API も時計も使わない。「いま」は引数で渡し、テストの中で固定する。
 *
 * `domain/social/pending.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。
 *
 * 引数の投稿は判定に効く項目（`status`・`deliveryMode`・`scheduledAt`・`approvedAt`・`publishStartedAt`・
 * `failureReason`）だけを持つオブジェクト（実装プラン T1）。`manualOutcomeEligibility` は真偽を返す
 * （実装プラン §8 の 41・設計 §8.6）。
 */

type PostStatus = 'draft' | 'awaiting_approval' | 'scheduled' | 'published' | 'failed';

interface PostLike {
  readonly status: PostStatus;
  readonly deliveryMode: 'auto' | 'manual';
  readonly scheduledAt: Date | null;
  readonly approvedAt: Date | null;
  readonly publishStartedAt: Date | null;
  readonly failureReason: string | null;
}

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';

interface PendingModule {
  readonly PENDING_KINDS: readonly string[];
  readonly PENDING_SORTS: readonly string[];
  readonly DEFAULT_PENDING_SORT: string;
  readonly MANUAL_NOT_POSTED_REASON: string;
  readonly pendingKindOf: (post: PostLike, now: Date) => PendingKind | null;
  readonly isPendingKind: (value: unknown) => boolean;
  readonly canOpenManualHandoff: (post: PostLike) => boolean;
  readonly manualOutcomeEligibility: (post: PostLike) => boolean;
}

const PENDING_MODULE: string = '@/domain/social/pending';

async function load(): Promise<PendingModule> {
  const module = (await import(/* @vite-ignore */ PENDING_MODULE)) as Partial<PendingModule>;
  if (
    typeof module.pendingKindOf !== 'function' ||
    typeof module.isPendingKind !== 'function' ||
    typeof module.canOpenManualHandoff !== 'function' ||
    typeof module.manualOutcomeEligibility !== 'function'
  ) {
    throw new Error(
      'domain/social/pending.ts に pendingKindOf / isPendingKind / canOpenManualHandoff / manualOutcomeEligibility が無い',
    );
  }
  return module as PendingModule;
}

const T = new Date('2026-10-23T09:00:00.000Z');
const MINUTE = 60_000;

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

/** 投稿の形（判定に効く項目だけ）。既定は「手動・予約・予約時刻ちょうど・承認を経ていない」。 */
function post(overrides: Partial<PostLike> = {}): PostLike {
  return {
    status: 'scheduled',
    deliveryMode: 'manual',
    scheduledAt: T,
    approvedAt: null,
    publishStartedAt: null,
    failureReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// #1 pendingKindOf（設計 §5.2）
// ---------------------------------------------------------------------------

describe('#1 pendingKindOf(post, now = T)', () => {
  const cases: readonly (readonly [string, PostLike, PendingKind | null])[] = [
    ['手動の予約・scheduledAt = T → manual_pending', post({ scheduledAt: T }), 'manual_pending'],
    [
      '手動の予約・scheduledAt = T−1m → manual_pending',
      post({ scheduledAt: at(-MINUTE) }),
      'manual_pending',
    ],
    ['手動の予約・scheduledAt = T+1m → scheduled', post({ scheduledAt: at(MINUTE) }), 'scheduled'],
    ['手動の予約・scheduledAt = null → scheduled', post({ scheduledAt: null }), 'scheduled'],
    [
      '自動の予約・scheduledAt = T−1m → scheduled',
      post({ deliveryMode: 'auto', scheduledAt: at(-MINUTE) }),
      'scheduled',
    ],
    [
      '自動の予約・着手印あり → scheduled',
      post({ deliveryMode: 'auto', scheduledAt: at(-MINUTE), publishStartedAt: at(-MINUTE) }),
      'scheduled',
    ],
    [
      '自動の予約・失敗理由あり（再試行待ち） → scheduled',
      post({ deliveryMode: 'auto', scheduledAt: at(-MINUTE), failureReason: 'timeout' }),
      'scheduled',
    ],
    [
      '承認待ち・自動 → awaiting_approval',
      post({ status: 'awaiting_approval', deliveryMode: 'auto', scheduledAt: at(-MINUTE) }),
      'awaiting_approval',
    ],
    [
      '承認待ち・手動（希望日時が過去でも） → awaiting_approval',
      post({ status: 'awaiting_approval', deliveryMode: 'manual', scheduledAt: at(-MINUTE) }),
      'awaiting_approval',
    ],
    [
      '承認待ち・手動・希望日時なし → awaiting_approval',
      post({ status: 'awaiting_approval', deliveryMode: 'manual', scheduledAt: null }),
      'awaiting_approval',
    ],
    ['下書き → null', post({ status: 'draft', scheduledAt: at(-MINUTE) }), null],
    ['配信済み → null', post({ status: 'published', scheduledAt: at(-MINUTE) }), null],
    ['失敗 → null', post({ status: 'failed', scheduledAt: at(-MINUTE) }), null],
  ];

  it.each(cases)('#1 %s', async (_title, input, expected) => {
    const { pendingKindOf } = await load();

    expect(pendingKindOf(input, T)).toBe(expected);
  });

  it('#1 承認済みの手動の予約は予約時刻を過ぎれば manual_pending、前なら scheduled', async () => {
    const { pendingKindOf } = await load();

    expect(pendingKindOf(post({ scheduledAt: at(-MINUTE), approvedAt: at(-MINUTE) }), T)).toBe(
      'manual_pending',
    );
    expect(pendingKindOf(post({ scheduledAt: at(MINUTE), approvedAt: at(-MINUTE) }), T)).toBe(
      'scheduled',
    );
  });

  it('#1 区分の境目は引数の now（同じ投稿でも now を 1ms 前にすると scheduled）', async () => {
    const { pendingKindOf } = await load();
    const input = post({ scheduledAt: T });

    expect(pendingKindOf(input, T)).toBe('manual_pending');
    expect(pendingKindOf(input, at(-1))).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
// #2 PENDING_KINDS・isPendingKind
// ---------------------------------------------------------------------------

describe('#2 PENDING_KINDS と isPendingKind', () => {
  it("#2 PENDING_KINDS が ['manual_pending', 'awaiting_approval', 'scheduled']（並びの順）", async () => {
    const { PENDING_KINDS } = await load();

    expect(PENDING_KINDS).toEqual(['manual_pending', 'awaiting_approval', 'scheduled']);
  });

  it.each(['manual_pending', 'awaiting_approval', 'scheduled'])(
    '#2 isPendingKind(%j) → 真',
    async (value) => {
      const { isPendingKind } = await load();

      expect(isPendingKind(value)).toBe(true);
    },
  );

  it.each(['draft', '', 'MANUAL_PENDING'])('#2 isPendingKind(%j) → 偽', async (value) => {
    const { isPendingKind } = await load();

    expect(isPendingKind(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #3 canOpenManualHandoff・#4 manualOutcomeEligibility（同じ表。実装プラン §8 の 41）
// ---------------------------------------------------------------------------

const HANDOFF_CASES: readonly (readonly [string, PostLike, boolean])[] = [
  ['手動・予約・予約日時が過去 → 真', post({ scheduledAt: at(-MINUTE) }), true],
  ['手動・予約・予約日時が未来 → 真', post({ scheduledAt: at(MINUTE) }), true],
  ['手動・予約・予約日時なし → 真', post({ scheduledAt: null }), true],
  [
    '手動・予約・承認済み（approvedAt あり）・未来 → 真',
    post({ scheduledAt: at(MINUTE), approvedAt: at(-MINUTE) }),
    true,
  ],
  [
    '手動・予約・承認済み（approvedAt あり）・過去 → 真',
    post({ scheduledAt: at(-MINUTE), approvedAt: at(-2 * MINUTE) }),
    true,
  ],
  ['手動・承認待ち → 偽', post({ status: 'awaiting_approval', scheduledAt: at(MINUTE) }), false],
  ['手動・下書き → 偽', post({ status: 'draft', scheduledAt: null }), false],
  ['手動・配信済み → 偽', post({ status: 'published' }), false],
  ['手動・失敗 → 偽', post({ status: 'failed' }), false],
  ['自動・予約 → 偽', post({ deliveryMode: 'auto', scheduledAt: at(-MINUTE) }), false],
];

describe('#3 canOpenManualHandoff（手動の予約だけ真）', () => {
  it.each(HANDOFF_CASES)('#3 %s', async (_title, input, expected) => {
    const { canOpenManualHandoff } = await load();

    expect(canOpenManualHandoff(input)).toBe(expected);
  });
});

describe('#4 manualOutcomeEligibility（#3 と同じ真偽）', () => {
  it.each(HANDOFF_CASES)('#4 %s', async (_title, input, expected) => {
    const { manualOutcomeEligibility } = await load();

    expect(manualOutcomeEligibility(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// #5 MANUAL_NOT_POSTED_REASON
// ---------------------------------------------------------------------------

describe('#5 MANUAL_NOT_POSTED_REASON', () => {
  it('#5 固定の文言が「手動投稿で『投稿しなかった』が選ばれました。」', async () => {
    const { MANUAL_NOT_POSTED_REASON } = await load();

    expect(MANUAL_NOT_POSTED_REASON).toBe('手動投稿で『投稿しなかった』が選ばれました。');
  });
});

// ---------------------------------------------------------------------------
// #76 並び順の定数（Domain 側）
// ---------------------------------------------------------------------------

describe('#76 PENDING_SORTS と DEFAULT_PENDING_SORT', () => {
  it("#76 PENDING_SORTS が ['action', 'time']", async () => {
    const { PENDING_SORTS } = await load();

    expect(PENDING_SORTS).toEqual(['action', 'time']);
  });

  it("#76 DEFAULT_PENDING_SORT が 'action'", async () => {
    const { DEFAULT_PENDING_SORT } = await load();

    expect(DEFAULT_PENDING_SORT).toBe('action');
  });
});
