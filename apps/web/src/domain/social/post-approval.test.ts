import { describe, expect, it } from 'vitest';
import { isDue, isInterrupted } from './publishing';
import {
  APPROVAL_TIMINGS,
  canApprove,
  canTransition,
  isManualOnlyPublisher,
  isManualPending,
  isPostStatus,
  POST_STATUSES,
  PUBLISH_TIMINGS,
  resolveApprovalSchedule,
  resolveCreateTiming,
  revokesApproval,
  SCHEDULED_AT_MAX_MS,
  type PostStatus,
} from './social';

/**
 * SNS 投稿の承認待ちの Domain（048-social-post-approval 設計 §5.5・§6.2.3・§6.3.3・§6.4.5・§6.6・§6.7.2・§6.10、
 * 受け入れ条件 #4〜#11）。
 *
 * **Domain 層の単体テスト。** DB も Plugin API も時計も使わない。「いま」は引数で渡し、テストの中で固定する。
 */

const T = new Date('2026-10-01T09:00:00.000Z');
const MS = 1;
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

// ---------------------------------------------------------------------------
// #4 状態の値
// ---------------------------------------------------------------------------

describe('#4 POST_STATUSES と isPostStatus', () => {
  it("#4 POST_STATUSES が ['draft', 'awaiting_approval', 'scheduled', 'published', 'failed']（状態の進む順）", () => {
    expect([...POST_STATUSES]).toEqual([
      'draft',
      'awaiting_approval',
      'scheduled',
      'published',
      'failed',
    ]);
  });

  it("#4 isPostStatus('awaiting_approval') が真", () => {
    expect(isPostStatus('awaiting_approval')).toBe(true);
  });

  it("#4 isPostStatus('pending') が偽", () => {
    expect(isPostStatus('pending')).toBe(false);
  });

  it('#4 登録の時機は now / scheduled / after_approval、承認の時機は now / scheduled（設計 §5.5）', () => {
    expect([...PUBLISH_TIMINGS]).toEqual(['now', 'scheduled', 'after_approval']);
    expect([...APPROVAL_TIMINGS]).toEqual(['now', 'scheduled']);
  });
});

// ---------------------------------------------------------------------------
// #5 状態遷移（設計 §6.6.2 の表の 25 通り）
// ---------------------------------------------------------------------------

/** 設計 §6.6.2 の表。行 = 現在、列 = 変更後（draft, awaiting_approval, scheduled, published, failed）。 */
const TRANSITION_TABLE: Record<string, readonly boolean[]> = {
  draft: [true, true, true, true, true],
  awaiting_approval: [true, true, false, false, false],
  scheduled: [true, true, true, true, true],
  published: [false, false, false, true, false],
  failed: [false, false, false, false, true],
};

const TABLE_ORDER = ['draft', 'awaiting_approval', 'scheduled', 'published', 'failed'] as const;

const TRANSITION_CASES = TABLE_ORDER.flatMap((from) =>
  TABLE_ORDER.map((to, index) => ({
    from,
    to,
    expected: TRANSITION_TABLE[from]?.[index] ?? false,
  })),
);

describe('#5 canTransition（PATCH の規則）', () => {
  it('#5 表は 25 通り', () => {
    expect(TRANSITION_CASES).toHaveLength(25);
  });

  it.each(TRANSITION_CASES)('#5 $from → $to は $expected', ({ from, to, expected }) => {
    expect(canTransition(from as PostStatus, to as PostStatus)).toBe(expected);
  });
});

describe('#5 canApprove', () => {
  it.each(TABLE_ORDER.map((status) => ({ status, expected: status === 'awaiting_approval' })))(
    '#5 canApprove($status) は $expected（承認待ちだけが承認できる）',
    ({ status, expected }) => {
      expect(canApprove(status as PostStatus)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// #6・#7 resolveCreateTiming（設計 §6.2.2 の表）
// ---------------------------------------------------------------------------

type CreateTimingInput = Parameters<typeof resolveCreateTiming>[0];

function createInput(overrides: Partial<CreateTimingInput>): CreateTimingInput {
  return {
    publishTiming: undefined,
    status: undefined,
    scheduledAt: null,
    manualOnly: false,
    now: T,
    ...overrides,
  } as CreateTimingInput;
}

describe('#6 resolveCreateTiming（manualOnly: false）', () => {
  it('#6 publishTiming 省略・status 省略 → draft・送った scheduledAt（今の振る舞い）', () => {
    expect(resolveCreateTiming(createInput({ scheduledAt: at(HOUR) }))).toEqual({
      ok: true,
      status: 'draft',
      scheduledAt: at(HOUR),
      approvalForced: false,
    });
  });

  it('#6 publishTiming 省略・status 省略・scheduledAt なし → draft・null', () => {
    expect(resolveCreateTiming(createInput({}))).toEqual({
      ok: true,
      status: 'draft',
      scheduledAt: null,
      approvalForced: false,
    });
  });

  it('#6 publishTiming 省略・status: scheduled ＋ 日時 → scheduled・その日時（今の振る舞い）', () => {
    expect(
      resolveCreateTiming(createInput({ status: 'scheduled', scheduledAt: at(HOUR) })),
    ).toEqual({ ok: true, status: 'scheduled', scheduledAt: at(HOUR), approvalForced: false });
  });

  it('#6 publishTiming 省略・status: awaiting_approval → awaiting_approval・送った日時（希望日時）', () => {
    expect(
      resolveCreateTiming(createInput({ status: 'awaiting_approval', scheduledAt: at(HOUR) })),
    ).toEqual({
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: at(HOUR),
      approvalForced: false,
    });
  });

  it.each(['draft', 'published', 'failed'] as const)(
    '#6 publishTiming 省略・status: %s → そのまま（今の振る舞い）',
    (status) => {
      expect(resolveCreateTiming(createInput({ status, scheduledAt: at(-HOUR) }))).toEqual({
        ok: true,
        status,
        scheduledAt: at(-HOUR),
        approvalForced: false,
      });
    },
  );

  it('#6 now → scheduled・scheduledAt はいまの時刻', () => {
    expect(resolveCreateTiming(createInput({ publishTiming: 'now' }))).toEqual({
      ok: true,
      status: 'scheduled',
      scheduledAt: T,
      approvalForced: false,
    });
  });

  it('#6 scheduled ＋ 未来の日時 → scheduled・その日時', () => {
    expect(
      resolveCreateTiming(createInput({ publishTiming: 'scheduled', scheduledAt: at(HOUR) })),
    ).toEqual({ ok: true, status: 'scheduled', scheduledAt: at(HOUR), approvalForced: false });
  });

  it('#6 scheduled ＋ 過去の日時 → scheduled・その日時（登録は過去も許す）', () => {
    expect(
      resolveCreateTiming(createInput({ publishTiming: 'scheduled', scheduledAt: at(-HOUR) })),
    ).toEqual({ ok: true, status: 'scheduled', scheduledAt: at(-HOUR), approvalForced: false });
  });

  it('#6 after_approval ＋ 日時なし → awaiting_approval・null', () => {
    expect(resolveCreateTiming(createInput({ publishTiming: 'after_approval' }))).toEqual({
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: null,
      approvalForced: false,
    });
  });

  it('#6 after_approval ＋ 日時 → awaiting_approval・送った日時（希望日時）', () => {
    expect(
      resolveCreateTiming(createInput({ publishTiming: 'after_approval', scheduledAt: at(HOUR) })),
    ).toEqual({
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: at(HOUR),
      approvalForced: false,
    });
  });

  it('#6 scheduled ＋ null → { ok: false, field: scheduledAt }', () => {
    const result = resolveCreateTiming(
      createInput({ publishTiming: 'scheduled', scheduledAt: null }),
    );

    expect(result).toMatchObject({ ok: false, field: 'scheduledAt' });
  });

  it('#6 scheduled ＋ null の文言は既存の「予約するときは予約日時を指定してください。」', () => {
    const result = resolveCreateTiming(
      createInput({ publishTiming: 'scheduled', scheduledAt: null }),
    );

    expect(result).toMatchObject({ message: '予約するときは予約日時を指定してください。' });
  });

  it('#6 status: scheduled ＋ null → 同じ 422（field: scheduledAt）', () => {
    const result = resolveCreateTiming(createInput({ status: 'scheduled', scheduledAt: null }));

    expect(result).toMatchObject({ ok: false, field: 'scheduledAt' });
  });
});

describe('#7 resolveCreateTiming（manualOnly: true。裁定 5・8）', () => {
  it('#7 now → awaiting_approval・null・approvalForced: true', () => {
    expect(resolveCreateTiming(createInput({ publishTiming: 'now', manualOnly: true }))).toEqual({
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: null,
      approvalForced: true,
    });
  });

  it('#7 scheduled ＋ 日時 → awaiting_approval・その日時・approvalForced: true', () => {
    expect(
      resolveCreateTiming(
        createInput({ publishTiming: 'scheduled', scheduledAt: at(HOUR), manualOnly: true }),
      ),
    ).toEqual({
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: at(HOUR),
      approvalForced: true,
    });
  });

  it('#7 after_approval → awaiting_approval・approvalForced: true', () => {
    expect(
      resolveCreateTiming(
        createInput({ publishTiming: 'after_approval', scheduledAt: at(HOUR), manualOnly: true }),
      ),
    ).toEqual({
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: at(HOUR),
      approvalForced: true,
    });
  });

  it('#7 publishTiming 省略 ＋ status: scheduled → scheduled・approvalForced: false（§6.7.4）', () => {
    expect(
      resolveCreateTiming(
        createInput({ status: 'scheduled', scheduledAt: at(HOUR), manualOnly: true }),
      ),
    ).toEqual({ ok: true, status: 'scheduled', scheduledAt: at(HOUR), approvalForced: false });
  });

  it('#7 publishTiming 省略・status 省略 → draft・approvalForced: false', () => {
    expect(resolveCreateTiming(createInput({ manualOnly: true }))).toEqual({
      ok: true,
      status: 'draft',
      scheduledAt: null,
      approvalForced: false,
    });
  });

  it('#7 scheduled ＋ null は manualOnly でも 422（表の段階の誤りは provider によらない。§6.2.2）', () => {
    const result = resolveCreateTiming(
      createInput({ publishTiming: 'scheduled', scheduledAt: null, manualOnly: true }),
    );

    expect(result).toMatchObject({ ok: false, field: 'scheduledAt' });
  });
});

// ---------------------------------------------------------------------------
// #8 resolveApprovalSchedule（設計 §6.4.5）
// ---------------------------------------------------------------------------

type ApprovalInput = Parameters<typeof resolveApprovalSchedule>[0];

function approvalInput(overrides: Partial<ApprovalInput>): ApprovalInput {
  return {
    requested: 'scheduled',
    scheduledAtInput: undefined,
    registered: null,
    manualOnly: false,
    now: T,
    ...overrides,
  } as ApprovalInput;
}

describe('#8 resolveApprovalSchedule', () => {
  it('#8 now → scheduledAt はいま（T）', () => {
    expect(resolveApprovalSchedule(approvalInput({ requested: 'now' }))).toEqual({
      ok: true,
      timing: 'now',
      scheduledAt: T,
      approvalForced: false,
    });
  });

  it('#8 now は要求の scheduledAt を無視していまにする', () => {
    expect(
      resolveApprovalSchedule(approvalInput({ requested: 'now', scheduledAtInput: at(HOUR) })),
    ).toMatchObject({ ok: true, timing: 'now', scheduledAt: T });
  });

  it('#8 scheduled ＋ 入力 T+1h → T+1h', () => {
    expect(resolveApprovalSchedule(approvalInput({ scheduledAtInput: at(HOUR) }))).toEqual({
      ok: true,
      timing: 'scheduled',
      scheduledAt: at(HOUR),
      approvalForced: false,
    });
  });

  it('#8 scheduled ＋ 入力 T+1h は登録 T+2h より優先する', () => {
    expect(
      resolveApprovalSchedule(
        approvalInput({ scheduledAtInput: at(HOUR), registered: at(2 * HOUR) }),
      ),
    ).toMatchObject({ ok: true, scheduledAt: at(HOUR) });
  });

  it('#8 scheduled ＋ 入力なし（undefined）＋ 登録 T+2h → T+2h', () => {
    expect(resolveApprovalSchedule(approvalInput({ registered: at(2 * HOUR) }))).toEqual({
      ok: true,
      timing: 'scheduled',
      scheduledAt: at(2 * HOUR),
      approvalForced: false,
    });
  });

  it('#8 scheduled ＋ 入力 null ＋ 登録 T+2h → T+2h', () => {
    expect(
      resolveApprovalSchedule(approvalInput({ scheduledAtInput: null, registered: at(2 * HOUR) })),
    ).toMatchObject({ ok: true, scheduledAt: at(2 * HOUR) });
  });

  it('#8 scheduled ＋ 入力なし ＋ 登録も null → 422 scheduledAt', () => {
    expect(resolveApprovalSchedule(approvalInput({}))).toMatchObject({
      ok: false,
      field: 'scheduledAt',
      message: '承認して予約するときは日時を指定してください。',
    });
  });

  it('#8 入力 T−1s → 422 scheduledAt（過ぎている）', () => {
    expect(resolveApprovalSchedule(approvalInput({ scheduledAtInput: at(-SECOND) }))).toMatchObject(
      {
        ok: false,
        field: 'scheduledAt',
        message: '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。',
      },
    );
  });

  it('#8 入力 T（いまと等しい）→ 422 scheduledAt', () => {
    expect(resolveApprovalSchedule(approvalInput({ scheduledAtInput: at(0) }))).toMatchObject({
      ok: false,
      field: 'scheduledAt',
    });
  });

  it('#8 入力 T+1ms → 通る（境界の 1 つ先）', () => {
    expect(resolveApprovalSchedule(approvalInput({ scheduledAtInput: at(MS) }))).toMatchObject({
      ok: true,
      scheduledAt: at(MS),
    });
  });

  it('#8 登録 T−1m ＋ 入力なし → 422 scheduledAt（即投稿に読み替えない）', () => {
    expect(resolveApprovalSchedule(approvalInput({ registered: at(-MINUTE) }))).toMatchObject({
      ok: false,
      field: 'scheduledAt',
    });
  });

  it('#8 範囲外の入力 → 422 scheduledAt', () => {
    expect(
      resolveApprovalSchedule(
        approvalInput({ scheduledAtInput: new Date(SCHEDULED_AT_MAX_MS + 1) }),
      ),
    ).toMatchObject({ ok: false, field: 'scheduledAt' });
  });

  it("#8 manualOnly ＋ scheduled ＋ 入力 T+1h → timing: 'now'・T・approvalForced: true", () => {
    expect(
      resolveApprovalSchedule(approvalInput({ manualOnly: true, scheduledAtInput: at(HOUR) })),
    ).toEqual({ ok: true, timing: 'now', scheduledAt: T, approvalForced: true });
  });

  it('#8 manualOnly ＋ now → approvalForced: false', () => {
    expect(resolveApprovalSchedule(approvalInput({ manualOnly: true, requested: 'now' }))).toEqual({
      ok: true,
      timing: 'now',
      scheduledAt: T,
      approvalForced: false,
    });
  });

  it('#8 manualOnly ＋ scheduled は登録が過去でも即投稿（422 にしない）', () => {
    expect(
      resolveApprovalSchedule(approvalInput({ manualOnly: true, registered: at(-MINUTE) })),
    ).toMatchObject({ ok: true, timing: 'now', scheduledAt: T, approvalForced: true });
  });
});

// ---------------------------------------------------------------------------
// #9 isManualOnlyPublisher（設計 §6.7.2）
// ---------------------------------------------------------------------------

describe('#9 isManualOnlyPublisher', () => {
  it('#9 { publish: false, manual: true } → 真', () => {
    expect(isManualOnlyPublisher({ publish: false, manual: true })).toBe(true);
  });

  it.each([
    { publish: true, manual: true },
    { publish: true, manual: false },
    { publish: false, manual: false },
  ])('#9 { publish: $publish, manual: $manual } → 偽', (publisher) => {
    expect(isManualOnlyPublisher(publisher)).toBe(false);
  });

  it('#9 null（publisher が無い）→ 偽', () => {
    expect(isManualOnlyPublisher(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #10 revokesApproval（設計 §6.3.3）
// ---------------------------------------------------------------------------

type RevokeCurrent = Parameters<typeof revokesApproval>[0];
type RevokeNext = Parameters<typeof revokesApproval>[1];

/** 承認を経た予約。毎回新しいオブジェクトを作る（同じ値でも別のインスタンスで比べる）。 */
function approvedScheduled(): RevokeCurrent {
  return {
    status: 'scheduled',
    approvedAt: at(-HOUR),
    body: '新製品のお知らせです。',
    media: [
      { url: 'https://cdn.example.com/a.jpg', alt: '製品の写真' },
      { url: 'https://cdn.example.com/b.jpg', alt: null },
    ],
    link: 'https://example.com/news/1',
    providerOptions: { replySettings: 'everyone', nested: { a: 1, b: [1, 2] } },
    deliveryMode: 'auto',
    scheduledAt: at(2 * HOUR),
  } as RevokeCurrent;
}

/** 変更後（明示しない限り同じ値・scheduled のまま）。 */
function nextOf(overrides: Record<string, unknown> = {}): RevokeNext {
  return { ...approvedScheduled(), ...overrides } as RevokeNext;
}

describe('#10 revokesApproval', () => {
  it('#10 承認済みの予約で body が変わる → 真', () => {
    expect(revokesApproval(approvedScheduled(), nextOf({ body: '書き換えた本文' }))).toBe(true);
  });

  it('#10 すべて同じ値（別のインスタンス）→ 偽', () => {
    expect(revokesApproval(approvedScheduled(), nextOf())).toBe(false);
  });

  it('#10 media の順序だけ入れ替え → 真（順序込みで比べる）', () => {
    const current = approvedScheduled();
    expect(revokesApproval(current, nextOf({ media: [...current.media].reverse() }))).toBe(true);
  });

  it('#10 media の代替テキストが変わる → 真', () => {
    expect(
      revokesApproval(
        approvedScheduled(),
        nextOf({
          media: [
            { url: 'https://cdn.example.com/a.jpg', alt: '別の説明' },
            { url: 'https://cdn.example.com/b.jpg', alt: null },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('#10 providerOptions のキーの順序だけ違う（中身は同じ）→ 偽', () => {
    expect(
      revokesApproval(
        approvedScheduled(),
        nextOf({ providerOptions: { nested: { b: [1, 2], a: 1 }, replySettings: 'everyone' } }),
      ),
    ).toBe(false);
  });

  it('#10 providerOptions の値が変わる → 真', () => {
    expect(
      revokesApproval(
        approvedScheduled(),
        nextOf({ providerOptions: { replySettings: 'following', nested: { a: 1, b: [1, 2] } } }),
      ),
    ).toBe(true);
  });

  it('#10 scheduledAt が 1ms 違う → 真', () => {
    expect(revokesApproval(approvedScheduled(), nextOf({ scheduledAt: at(2 * HOUR + MS) }))).toBe(
      true,
    );
  });

  it('#10 deliveryMode が変わる → 真', () => {
    expect(revokesApproval(approvedScheduled(), nextOf({ deliveryMode: 'manual' }))).toBe(true);
  });

  it('#10 link が変わる → 真', () => {
    expect(
      revokesApproval(approvedScheduled(), nextOf({ link: 'https://example.com/news/2' })),
    ).toBe(true);
  });

  it('#10 approvedAt: null（承認を経ていない予約）→ 偽', () => {
    const current = { ...approvedScheduled(), approvedAt: null } as RevokeCurrent;
    expect(revokesApproval(current, nextOf({ body: '書き換えた本文', approvedAt: null }))).toBe(
      false,
    );
  });

  it('#10 変更後の状態が draft → 偽', () => {
    expect(
      revokesApproval(approvedScheduled(), nextOf({ status: 'draft', body: '書き換えた本文' })),
    ).toBe(false);
  });

  it('#10 変更後の状態が awaiting_approval（明示）→ 偽（条件 2 の対照）', () => {
    expect(
      revokesApproval(
        approvedScheduled(),
        nextOf({ status: 'awaiting_approval', body: '書き換えた本文' }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #11 配信ジョブ・手動投稿の判定は承認待ちを拾わない（設計 §6.10）
// ---------------------------------------------------------------------------

describe('#11 isDue / isInterrupted / isManualPending は承認待ちで偽', () => {
  const due = {
    deliveryMode: 'auto',
    scheduledAt: at(-MINUTE),
    nextAttemptAt: null,
    publishStartedAt: null,
  } as const;

  it('#11 対照：他の条件が揃った scheduled の行は isDue が真', () => {
    expect(isDue({ ...due, status: 'scheduled' }, T)).toBe(true);
  });

  it('#11 同じ条件の awaiting_approval の行は isDue が偽', () => {
    expect(isDue({ ...due, status: 'awaiting_approval' as PostStatus }, T)).toBe(false);
  });

  const started = { deliveryMode: 'auto', publishStartedAt: at(-MINUTE) } as const;

  it('#11 対照：着手印のある scheduled の行は isInterrupted が真', () => {
    expect(isInterrupted({ ...started, status: 'scheduled' })).toBe(true);
  });

  it('#11 同じ条件の awaiting_approval の行は isInterrupted が偽', () => {
    expect(isInterrupted({ ...started, status: 'awaiting_approval' as PostStatus })).toBe(false);
  });

  const manual = { deliveryMode: 'manual', scheduledAt: at(-MINUTE) } as const;

  it('#11 対照：時刻の来た手動投稿の scheduled の行は isManualPending が真', () => {
    expect(isManualPending({ ...manual, status: 'scheduled' }, T)).toBe(true);
  });

  it('#11 同じ条件の awaiting_approval の行は isManualPending が偽', () => {
    expect(isManualPending({ ...manual, status: 'awaiting_approval' as PostStatus }, T)).toBe(
      false,
    );
  });
});
