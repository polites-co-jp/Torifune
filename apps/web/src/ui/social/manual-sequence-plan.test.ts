import { describe, expect, it } from 'vitest';

/**
 * 選んだ手動投稿を順に投稿の純関数（055-social-pending-tab 設計 §9.5.1・§9.5.2・§9.12、受け入れ条件 #43・#44、
 * 実装プラン §8 の 42・43）。
 *
 * * #43：`manualSequencePlanOf(selectedRows)` は渡された順（表の並び）を保ち、`deliveryMode = 'manual'` かつ
 *   `status = 'scheduled'` かつ `handoff.ok` の行を対象にする。対象外は理由（`awaiting_approval`・
 *   `handoff_unavailable`・`auto`）ごとに数える。0 件の選択は対象 0
 * * #44：`manualOutcomeRequestBody(outcome, expectedUpdatedAt, externalUrl)` は、`posted` で URL が空なら
 *   `externalUrl` を含まず、URL があれば（前後の空白を落として）含む。`not_posted` は含まない
 *
 * `ui/social/manual-sequence-plan.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。行の型は設計 §9.3.5 の `PendingRow` を写す。
 * `excluded` の並びと 0 件の理由を含めるかは設計が決めていないので、件数が 1 以上の理由を理由の名前で比べる
 * （実装プラン §8 の 60）。
 */

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';

type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled';
    };

/** 設計 §9.3.5 の `PendingRow`（054 の `PostRow` に足す）。 */
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
  readonly kind: PendingKind;
  readonly elapsedText?: string;
  readonly handoff?: ManualHandoffOutcome;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

type ExcludedReason = 'awaiting_approval' | 'handoff_unavailable' | 'auto';

interface ManualSequencePlan {
  readonly targets: readonly PendingRow[];
  readonly excluded: readonly { readonly reason: ExcludedReason; readonly count: number }[];
}

interface ManualOutcomeBody {
  readonly outcome: 'posted' | 'not_posted';
  readonly expectedUpdatedAt: string;
  readonly externalUrl?: string;
}

interface ManualSequencePlanModule {
  readonly manualSequencePlanOf: (rows: readonly PendingRow[]) => ManualSequencePlan;
  readonly manualOutcomeRequestBody: (
    outcome: 'posted' | 'not_posted',
    expectedUpdatedAt: string,
    externalUrl: string,
  ) => ManualOutcomeBody;
}

const MODULE: string = '@/ui/social/manual-sequence-plan';

async function load(): Promise<ManualSequencePlanModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Partial<ManualSequencePlanModule>;
  for (const name of ['manualSequencePlanOf', 'manualOutcomeRequestBody'] as const) {
    if (typeof module[name] !== 'function') {
      throw new Error(`ui/social/manual-sequence-plan.ts に ${name} が無い`);
    }
  }
  return module as ManualSequencePlanModule;
}

const HANDOFF_OK: ManualHandoffOutcome = {
  ok: true,
  url: 'https://example.com/intent?text=a',
  note: null,
};

let sequence = 0;

function row(overrides: Partial<PendingRow> = {}): PendingRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000055${suffix}`,
    socialAccountId: '01900000-0000-7000-8000-0000000055a1',
    body: `手動投稿の本文 ${suffix}`,
    scheduledAt: '2026-10-24T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'manual',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    updatedAt: `2026-10-23T00:00:00.${suffix.slice(1)}Z`,
    kind: 'scheduled',
    handoff: HANDOFF_OK,
    link: null,
    media: [],
    requestedAt: '2026-10-23T00:00:00.000Z',
    warning: null,
    ...overrides,
  };
}

/** 件数が 1 以上の対象外を、理由の名前で引けるようにする。 */
function excludedOf(plan: ManualSequencePlan): Record<string, number> {
  return Object.fromEntries(
    plan.excluded.filter((item) => item.count > 0).map((item) => [item.reason, item.count]),
  );
}

// ---------------------------------------------------------------------------
// #43 manualSequencePlanOf
// ---------------------------------------------------------------------------

describe('#43 manualSequencePlanOf', () => {
  const pendingPast = row({ kind: 'manual_pending', body: '予約時刻を過ぎた手動投稿' });
  const scheduledFuture = row({
    kind: 'scheduled',
    body: '予約時刻前の手動投稿',
    scheduledAt: '2026-10-30T01:00:00.000Z',
  });
  const scheduledNoTime = row({
    kind: 'scheduled',
    body: '予約日時の無い手動投稿',
    scheduledAt: null,
  });
  const awaitingManual = row({
    status: 'awaiting_approval',
    kind: 'awaiting_approval',
    body: '承認待ちの手動投稿',
    handoff: undefined,
  });
  const unavailable = row({
    kind: 'manual_pending',
    body: '開けない手動投稿',
    handoff: { ok: false, reason: 'plugin_error' },
  });
  const auto = row({
    deliveryMode: 'auto',
    kind: 'scheduled',
    body: '自動配信の予約',
    handoff: undefined,
  });

  it('#43 手動の予約（handoff.ok）が対象：予約時刻の前後・予約日時なしを問わない', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([pendingPast, scheduledFuture, scheduledNoTime]);

    expect(plan.targets.map((target) => target.id)).toEqual([
      pendingPast.id,
      scheduledFuture.id,
      scheduledNoTime.id,
    ]);
    expect(excludedOf(plan)).toEqual({});
  });

  it('#43 表の並びの順（渡された順）を保つ', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([scheduledNoTime, auto, pendingPast, scheduledFuture]);

    expect(plan.targets.map((target) => target.id)).toEqual([
      scheduledNoTime.id,
      pendingPast.id,
      scheduledFuture.id,
    ]);
  });

  it('#43 承認待ちの手動投稿は対象外（理由 awaiting_approval）', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([pendingPast, awaitingManual]);

    expect(plan.targets.map((target) => target.id)).toEqual([pendingPast.id]);
    expect(excludedOf(plan)).toEqual({ awaiting_approval: 1 });
  });

  it('#43 handoff が開けない手動の予約は対象外（理由 handoff_unavailable）', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([unavailable, scheduledFuture]);

    expect(plan.targets.map((target) => target.id)).toEqual([scheduledFuture.id]);
    expect(excludedOf(plan)).toEqual({ handoff_unavailable: 1 });
  });

  it('#43 自動配信の行は対象外（理由 auto）', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([auto, pendingPast]);

    expect(plan.targets.map((target) => target.id)).toEqual([pendingPast.id]);
    expect(excludedOf(plan)).toEqual({ auto: 1 });
  });

  it('#43 理由ごとに数える（3 つの理由が混ざる）', async () => {
    const awaitingManual2 = row({
      status: 'awaiting_approval',
      kind: 'awaiting_approval',
      body: '承認待ちの手動投稿 2',
      handoff: undefined,
    });
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([
      pendingPast,
      awaitingManual,
      unavailable,
      auto,
      awaitingManual2,
      scheduledFuture,
    ]);

    expect(plan.targets.map((target) => target.id)).toEqual([pendingPast.id, scheduledFuture.id]);
    expect(excludedOf(plan)).toEqual({ awaiting_approval: 2, handoff_unavailable: 1, auto: 1 });
  });

  it('#43 対象外の理由は 3 つのどれか', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([awaitingManual, unavailable, auto]);

    for (const item of plan.excluded) {
      expect(['awaiting_approval', 'handoff_unavailable', 'auto']).toContain(item.reason);
    }
    expect(plan.targets).toEqual([]);
  });

  it('#43 0 件の選択 → 対象 0・対象外 0', async () => {
    const { manualSequencePlanOf } = await load();

    const plan = manualSequencePlanOf([]);

    expect(plan.targets).toEqual([]);
    expect(excludedOf(plan)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// #44 manualOutcomeRequestBody
// ---------------------------------------------------------------------------

describe('#44 manualOutcomeRequestBody', () => {
  const UPDATED_AT = '2026-10-23T00:00:00.123Z';

  it('#44 posted で URL が空なら { outcome, expectedUpdatedAt }（externalUrl を含まない）', async () => {
    const { manualOutcomeRequestBody } = await load();

    const body = manualOutcomeRequestBody('posted', UPDATED_AT, '');

    expect(body).toEqual({ outcome: 'posted', expectedUpdatedAt: UPDATED_AT });
    expect(Object.keys(body)).not.toContain('externalUrl');
  });

  it('#44 posted で URL が空白だけなら externalUrl を含まない', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(Object.keys(manualOutcomeRequestBody('posted', UPDATED_AT, '   '))).not.toContain(
      'externalUrl',
    );
  });

  it('#44 posted で URL があれば externalUrl を含む', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(
      manualOutcomeRequestBody('posted', UPDATED_AT, 'https://x.com/torifune/status/1'),
    ).toEqual({
      outcome: 'posted',
      expectedUpdatedAt: UPDATED_AT,
      externalUrl: 'https://x.com/torifune/status/1',
    });
  });

  it('#44 posted の URL は前後の空白を落とす', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(
      manualOutcomeRequestBody('posted', UPDATED_AT, '  https://x.com/torifune/status/1 \n')
        .externalUrl,
    ).toBe('https://x.com/torifune/status/1');
  });

  it('#44 not_posted は URL を渡しても externalUrl を含まない', async () => {
    const { manualOutcomeRequestBody } = await load();

    const body = manualOutcomeRequestBody(
      'not_posted',
      UPDATED_AT,
      'https://x.com/torifune/status/1',
    );

    expect(body).toEqual({ outcome: 'not_posted', expectedUpdatedAt: UPDATED_AT });
    expect(Object.keys(body)).not.toContain('externalUrl');
  });

  it('#44 not_posted で URL が空でも { outcome, expectedUpdatedAt }', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(manualOutcomeRequestBody('not_posted', UPDATED_AT, '')).toEqual({
      outcome: 'not_posted',
      expectedUpdatedAt: UPDATED_AT,
    });
  });
});
