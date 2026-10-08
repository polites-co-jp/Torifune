import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/domain/repository';
import { resolveApprovalSchedule } from './social';

/**
 * 承認の時刻の失敗の理由と、一括の項目の誤りの型（054-bulk-post-actions 設計 §6・§8.1.1、受け入れ条件 #9）。
 *
 * **Domain 層の単体テスト。** 「いま」は引数で渡し、テストの中で固定する。
 *
 * * `resolveApprovalSchedule` の失敗に `reason`（`missing` / `past` / `out_of_range`）が付き、`field`・`message` は 048 のまま
 * * `ApprovalScheduleError` と `SocialPostIneligibleError` が `ValidationError` の派生で `reason` を持つ
 *
 * `reason` も 2 つの誤りの型もまだ無いので、`reason` は `Record<string, unknown>` として読み、型は指定子を `string` の
 * 定数に置いた動的 import で読む（053 実装プラン §8 の 19）。
 *
 * 構築の引数：`ApprovalScheduleError(field, message, reason)` は実装プラン T10 のとおり。`SocialPostIneligibleError` は
 * 設計・プランが引数を決めていないので `(reason, message)` とする（実装プラン §8 の 29）。
 */

const T = new Date('2026-10-08T09:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

type ApprovalInput = Parameters<typeof resolveApprovalSchedule>[0];

function approvalInput(overrides: Partial<ApprovalInput>): ApprovalInput {
  return {
    requested: 'scheduled',
    scheduledAtInput: undefined,
    registered: null,
    manualOnly: false,
    now: T,
    ...overrides,
  };
}

/** 結果を項目の名前で読む（`reason` はまだ型に無い）。 */
function fieldsOf(input: Partial<ApprovalInput>): Record<string, unknown> {
  return resolveApprovalSchedule(approvalInput(input)) as unknown as Record<string, unknown>;
}

const MISSING_MESSAGE = '承認して予約するときは日時を指定してください。';
const PAST_MESSAGE = '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。';
const OUT_OF_RANGE_MESSAGE =
  '0001-01-01T00:00:00Z から 9999-12-31T23:59:59.999Z までの日時を指定してください。';

/** 9999-12-31T23:59:59.999Z の 1 ミリ秒後（範囲外）。 */
const OUT_OF_RANGE = new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999) + 1);

// ---------------------------------------------------------------------------
// #9 resolveApprovalSchedule の reason
// ---------------------------------------------------------------------------

describe('#9 resolveApprovalSchedule の失敗に reason が付く', () => {
  it('#9 希望日時なし（要求にも日時なし）→ reason: missing', () => {
    expect(fieldsOf({})['reason']).toBe('missing');
  });

  it('#9 希望日時が過去 → reason: past', () => {
    expect(fieldsOf({ registered: at(-HOUR) })['reason']).toBe('past');
  });

  it('#9 希望日時がいまと等しい → reason: past', () => {
    expect(fieldsOf({ registered: T })['reason']).toBe('past');
  });

  it('#9 要求の日時が過去 → reason: past', () => {
    expect(fieldsOf({ scheduledAtInput: at(-MINUTE), registered: at(HOUR) })['reason']).toBe(
      'past',
    );
  });

  it('#9 要求の日時が範囲外 → reason: out_of_range', () => {
    expect(fieldsOf({ scheduledAtInput: OUT_OF_RANGE })['reason']).toBe('out_of_range');
  });

  it('#9 missing の ok・field・message は 048 のまま', () => {
    expect(fieldsOf({})).toMatchObject({
      ok: false,
      field: 'scheduledAt',
      message: MISSING_MESSAGE,
    });
  });

  it('#9 past の ok・field・message は 048 のまま', () => {
    expect(fieldsOf({ registered: at(-HOUR) })).toMatchObject({
      ok: false,
      field: 'scheduledAt',
      message: PAST_MESSAGE,
    });
  });

  it('#9 out_of_range の ok・field・message は 048 のまま', () => {
    expect(fieldsOf({ scheduledAtInput: OUT_OF_RANGE })).toMatchObject({
      ok: false,
      field: 'scheduledAt',
      message: OUT_OF_RANGE_MESSAGE,
    });
  });

  it('#9 成功（希望日時が未来）には reason が無い', () => {
    const result = fieldsOf({ registered: at(HOUR) });

    expect(result['ok']).toBe(true);
    expect(result['reason']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #9 ApprovalScheduleError と SocialPostIneligibleError
// ---------------------------------------------------------------------------

type ErrorConstructor3 = new (a: string, b: string, c: string) => Error;
type ErrorConstructor2 = new (a: string, b: string) => Error;

interface ErrorModule {
  readonly ApprovalScheduleError?: ErrorConstructor3;
  readonly SocialPostIneligibleError?: ErrorConstructor2;
}

const SOCIAL_MODULE: string = '@/domain/social/social';

async function loadErrors(): Promise<{
  readonly ApprovalScheduleError: ErrorConstructor3;
  readonly SocialPostIneligibleError: ErrorConstructor2;
}> {
  const module = (await import(/* @vite-ignore */ SOCIAL_MODULE)) as ErrorModule;
  if (module.ApprovalScheduleError === undefined) {
    throw new Error('domain/social/social.ts に ApprovalScheduleError が無い');
  }
  if (module.SocialPostIneligibleError === undefined) {
    throw new Error('domain/social/social.ts に SocialPostIneligibleError が無い');
  }
  return {
    ApprovalScheduleError: module.ApprovalScheduleError,
    SocialPostIneligibleError: module.SocialPostIneligibleError,
  };
}

describe('#9 ApprovalScheduleError', () => {
  it('#9 ValidationError の派生（instanceof）', async () => {
    const { ApprovalScheduleError } = await loadErrors();

    expect(new ApprovalScheduleError('scheduledAt', PAST_MESSAGE, 'past')).toBeInstanceOf(
      ValidationError,
    );
  });

  it('#9 reason を持つ', async () => {
    const { ApprovalScheduleError } = await loadErrors();
    const error = new ApprovalScheduleError('scheduledAt', MISSING_MESSAGE, 'missing');

    expect((error as unknown as Record<string, unknown>)['reason']).toBe('missing');
  });

  it('#9 field と detail は 1 件の承認の 422（details.scheduledAt と文言）と同じ', async () => {
    const { ApprovalScheduleError } = await loadErrors();
    const error = new ApprovalScheduleError('scheduledAt', PAST_MESSAGE, 'past');

    expect(error).toMatchObject({ field: 'scheduledAt', detail: PAST_MESSAGE });
  });
});

describe('#9 SocialPostIneligibleError', () => {
  it('#9 ValidationError の派生（instanceof）', async () => {
    const { SocialPostIneligibleError } = await loadErrors();

    expect(
      new SocialPostIneligibleError(
        'already_due',
        '予約日時を過ぎているため、既に配信の順番を待っています。',
      ),
    ).toBeInstanceOf(ValidationError);
  });

  it.each(['not_applicable', 'already_due', 'publishing', 'approval_required'])(
    '#9 reason（%s）を持つ',
    async (reason) => {
      const { SocialPostIneligibleError } = await loadErrors();
      const error = new SocialPostIneligibleError(reason, '対象外の理由');

      expect((error as unknown as Record<string, unknown>)['reason']).toBe(reason);
    },
  );
});
