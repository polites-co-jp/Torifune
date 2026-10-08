import { describe, expect, it } from 'vitest';

/**
 * 一括操作の定数と判定の純関数（054-bulk-post-actions 設計 §5.4・§5.5・§8.1・§8.3・§8.4、受け入れ条件 #7・#8・#10）。
 *
 * **Domain 層の単体テスト。** DB も Plugin API も時計も使わない。「いま」は引数で渡し、テストの中で固定する。
 *
 * `domain/social/bulk.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （053 実装プラン §8 の 19）。
 *
 * 判定の戻り値の形は設計が決めていないので、`resolveApprovalSchedule` の結果と同じ流儀で
 * 対象なら `{ ok: true }`、対象外なら `{ ok: false, reason, message }` とする（実装プラン §8 の 28）。
 * `message` は設計 §8.3・§8.4 の文言（1 件の操作の文言にそろえたもの）。
 */

type Eligibility =
  { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly message: string };

interface PostLike {
  readonly status: 'draft' | 'awaiting_approval' | 'scheduled' | 'published' | 'failed';
  readonly deliveryMode: 'auto' | 'manual';
  readonly scheduledAt: Date | null;
  readonly publishStartedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

interface BulkModule {
  readonly BULK_MAX_ITEMS: number;
  readonly BULK_BUDGET_MS: number;
  readonly BULK_FAILURE_REASONS: readonly string[];
  readonly BULK_EFFECTS: readonly string[];
  readonly BULK_DELETABLE_STATUSES: readonly string[];
  readonly publishNowEligibility: (post: PostLike, now: Date) => Eligibility;
  readonly bulkDeleteEligibility: (post: PostLike) => Eligibility;
}

const BULK_MODULE: string = '@/domain/social/bulk';

/**
 * API の一覧の `perPage` の上限（`api/query.ts` の `MAX_PER_PAGE`）。Domain のテストから API 層を静的に import すると
 * レイヤの検査（ESLint）に掛かるので、比べるためだけに動的に読む。
 */
const QUERY_MODULE: string = '@/api/query';

async function maxPerPage(): Promise<number | undefined> {
  const module = (await import(/* @vite-ignore */ QUERY_MODULE)) as { MAX_PER_PAGE?: number };
  return module.MAX_PER_PAGE;
}

async function load(): Promise<BulkModule> {
  const module = (await import(/* @vite-ignore */ BULK_MODULE)) as Partial<BulkModule>;
  if (
    typeof module.publishNowEligibility !== 'function' ||
    typeof module.bulkDeleteEligibility !== 'function'
  ) {
    throw new Error(
      'domain/social/bulk.ts に publishNowEligibility / bulkDeleteEligibility が無い',
    );
  }
  return module as BulkModule;
}

const T = new Date('2026-10-08T09:00:00.000Z');
const MINUTE = 60_000;

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

/** 投稿の形（判定に効く項目だけ）。既定は「自動・未来の予約・承認を経ていない」。 */
function post(overrides: Partial<PostLike> = {}): PostLike {
  return {
    status: 'scheduled',
    deliveryMode: 'auto',
    scheduledAt: at(MINUTE),
    publishStartedAt: null,
    approvedAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

const PUBLISHING_MESSAGE =
  '配信を開始しているため変更できません。結果が記録されるまで待ってください。';
const ALREADY_DUE_MESSAGE = '予約日時を過ぎているため、既に配信の順番を待っています。';
const DELETE_NOT_APPLICABLE_MESSAGE =
  '配信済み・失敗の投稿は一括取り消しの対象外です。1 件ずつ削除してください。';

// ---------------------------------------------------------------------------
// #7 publishNowEligibility（設計 §8.3）
// ---------------------------------------------------------------------------

describe('#7 publishNowEligibility', () => {
  it('#7 scheduled・scheduledAt = T+1m → 対象', async () => {
    const { publishNowEligibility } = await load();

    expect(publishNowEligibility(post({ scheduledAt: at(MINUTE) }), T)).toMatchObject({
      ok: true,
    });
  });

  it('#7 scheduled・scheduledAt = null → 対象', async () => {
    const { publishNowEligibility } = await load();

    expect(publishNowEligibility(post({ scheduledAt: null }), T)).toMatchObject({ ok: true });
  });

  it('#7 承認済みの未来の予約も Domain の判定では対象（承認の権限は UseCase が見る）', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(post({ scheduledAt: at(MINUTE), approvedAt: at(-MINUTE) }), T),
    ).toMatchObject({ ok: true });
  });

  it('#7 manual の未来の予約 → 対象', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(post({ deliveryMode: 'manual', scheduledAt: at(MINUTE) }), T),
    ).toMatchObject({ ok: true });
  });

  it('#7 scheduledAt = T（いまと等しい）→ already_due', async () => {
    const { publishNowEligibility } = await load();

    expect(publishNowEligibility(post({ scheduledAt: T }), T)).toMatchObject({
      ok: false,
      reason: 'already_due',
    });
  });

  it('#7 scheduledAt = T−1m → already_due', async () => {
    const { publishNowEligibility } = await load();

    expect(publishNowEligibility(post({ scheduledAt: at(-MINUTE) }), T)).toMatchObject({
      ok: false,
      reason: 'already_due',
    });
  });

  it('#7 再試行待ち（scheduledAt = T−1m・未来の nextAttemptAt）→ already_due', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(post({ scheduledAt: at(-MINUTE), nextAttemptAt: at(MINUTE) }), T),
    ).toMatchObject({ ok: false, reason: 'already_due' });
  });

  it('#7 already_due の message は設計 §8.3 の文言', async () => {
    const { publishNowEligibility } = await load();

    expect(publishNowEligibility(post({ scheduledAt: at(-MINUTE) }), T)).toMatchObject({
      message: ALREADY_DUE_MESSAGE,
    });
  });

  it('#7 auto・着手印あり・scheduledAt = T−1m → publishing（already_due より先）', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(post({ scheduledAt: at(-MINUTE), publishStartedAt: at(-MINUTE) }), T),
    ).toMatchObject({ ok: false, reason: 'publishing' });
  });

  it('#7 auto・着手印あり・scheduledAt が未来 → publishing', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(post({ scheduledAt: at(MINUTE), publishStartedAt: at(-MINUTE) }), T),
    ).toMatchObject({ ok: false, reason: 'publishing' });
  });

  it('#7 publishing の message は既存の配信中の文言', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(post({ scheduledAt: at(-MINUTE), publishStartedAt: at(-MINUTE) }), T),
    ).toMatchObject({ message: PUBLISHING_MESSAGE });
  });

  it.each(['draft', 'awaiting_approval', 'published', 'failed'] as const)(
    '#7 %s → not_applicable',
    async (status) => {
      const { publishNowEligibility } = await load();

      expect(publishNowEligibility(post({ status }), T)).toMatchObject({
        ok: false,
        reason: 'not_applicable',
      });
    },
  );

  it('#7 not_applicable の message は「予約済みの投稿ではありません（いまの状態：draft）。」', async () => {
    const { publishNowEligibility } = await load();

    expect(publishNowEligibility(post({ status: 'draft' }), T)).toMatchObject({
      message: '予約済みの投稿ではありません（いまの状態：draft）。',
    });
  });

  it('#7 状態の判定が先：配信済みなら過去の日時・着手印があっても not_applicable', async () => {
    const { publishNowEligibility } = await load();

    expect(
      publishNowEligibility(
        post({ status: 'published', scheduledAt: at(-MINUTE), publishStartedAt: at(-MINUTE) }),
        T,
      ),
    ).toMatchObject({ ok: false, reason: 'not_applicable' });
  });
});

// ---------------------------------------------------------------------------
// #8 BULK_DELETABLE_STATUSES と bulkDeleteEligibility（設計 §5.5・§8.4）
// ---------------------------------------------------------------------------

describe('#8 BULK_DELETABLE_STATUSES と bulkDeleteEligibility', () => {
  it("#8 BULK_DELETABLE_STATUSES が ['draft', 'awaiting_approval', 'scheduled']", async () => {
    const { BULK_DELETABLE_STATUSES } = await load();

    expect([...BULK_DELETABLE_STATUSES]).toEqual(['draft', 'awaiting_approval', 'scheduled']);
  });

  it.each([
    ['draft', post({ status: 'draft', scheduledAt: null })],
    ['awaiting_approval', post({ status: 'awaiting_approval' })],
    ['scheduled（auto・配信中でない）', post({ status: 'scheduled' })],
    ['scheduled（manual）', post({ status: 'scheduled', deliveryMode: 'manual' })],
    ['scheduled（期限の来た予約・着手印なし）', post({ scheduledAt: at(-MINUTE) })],
  ] as const)('#8 %s → 対象', async (_label, target) => {
    const { bulkDeleteEligibility } = await load();

    expect(bulkDeleteEligibility(target)).toMatchObject({ ok: true });
  });

  it.each(['published', 'failed'] as const)('#8 %s → not_applicable', async (status) => {
    const { bulkDeleteEligibility } = await load();

    expect(bulkDeleteEligibility(post({ status }))).toMatchObject({
      ok: false,
      reason: 'not_applicable',
    });
  });

  it('#8 not_applicable の message は設計 §8.4 の文言', async () => {
    const { bulkDeleteEligibility } = await load();

    expect(bulkDeleteEligibility(post({ status: 'published' }))).toMatchObject({
      message: DELETE_NOT_APPLICABLE_MESSAGE,
    });
  });

  it('#8 scheduled・auto・着手印あり → publishing', async () => {
    const { bulkDeleteEligibility } = await load();

    expect(
      bulkDeleteEligibility(post({ scheduledAt: at(-MINUTE), publishStartedAt: at(-MINUTE) })),
    ).toMatchObject({ ok: false, reason: 'publishing' });
  });

  it('#8 publishing の message は既存の配信中の文言', async () => {
    const { bulkDeleteEligibility } = await load();

    expect(
      bulkDeleteEligibility(post({ scheduledAt: at(-MINUTE), publishStartedAt: at(-MINUTE) })),
    ).toMatchObject({ message: PUBLISHING_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// #10 定数（設計 §8.1）
// ---------------------------------------------------------------------------

describe('#10 一括の定数', () => {
  it('#10 BULK_MAX_ITEMS === MAX_PER_PAGE === 100', async () => {
    const { BULK_MAX_ITEMS } = await load();

    expect(BULK_MAX_ITEMS).toBe(100);
    expect(BULK_MAX_ITEMS).toBe(await maxPerPage());
  });

  it('#10 BULK_BUDGET_MS は 25 000（設計 §8.1・§8.6）', async () => {
    const { BULK_BUDGET_MS } = await load();

    expect(BULK_BUDGET_MS).toBe(25_000);
  });

  it('#10 BULK_FAILURE_REASONS が設計 §8.1 の並び', async () => {
    const { BULK_FAILURE_REASONS } = await load();

    expect([...BULK_FAILURE_REASONS]).toEqual([
      'not_found',
      'not_applicable',
      'already_due',
      'publishing',
      'approval_required',
      'stale',
      'no_desired_time',
      'desired_time_passed',
      'validation',
      'timeout',
      'internal_error',
    ]);
  });

  it('#10 BULK_EFFECTS が設計 §8.1 の並び', async () => {
    const { BULK_EFFECTS } = await load();

    expect([...BULK_EFFECTS]).toEqual([
      'approved_now',
      'approved_scheduled',
      'approved_forced_now',
      'queued',
      'manual_pending',
      'deleted',
    ]);
  });
});
