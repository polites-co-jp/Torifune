import { describe, expect, it } from 'vitest';
import {
  canRetry,
  decidePublishOutcome,
  isDue,
  isInterrupted,
  MAX_RETRY_AFTER_MS,
  pluginErrorReason,
  PUBLISH_MAX_ATTEMPTS,
  publishRetryDelayMs,
  redactCredentialValues,
  TIMEOUT_REASON,
} from './publishing';

/**
 * 配信の純関数（035-social-publishing 設計 §5.6.2、受け入れ条件 #6、#7、#8、#9、#11）。
 *
 * **Domain 層の単体テスト。** DB も外部 API も時計も使わない。
 * `now` は引数で渡し、テストの中で固定する。
 */

const NOW = new Date('2026-09-22T10:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60_000;

/** 取り出し条件の入力。公開された引数の形だけに依存する。 */
type DueInput = Parameters<typeof isDue>[0];
type InterruptedInput = Parameters<typeof isInterrupted>[0];

/** 「期限の来た自動配信の投稿」に差分を重ねる。 */
function duePost(overrides: Partial<DueInput> = {}): DueInput {
  return {
    status: 'scheduled',
    deliveryMode: 'auto',
    scheduledAt: new Date(NOW.getTime() - SECOND),
    nextAttemptAt: null,
    publishStartedAt: null,
    ...overrides,
  };
}

/** 「配信が進行中の投稿」に差分を重ねる。 */
function startedPost(overrides: Partial<InterruptedInput> = {}): InterruptedInput {
  return {
    status: 'scheduled',
    deliveryMode: 'auto',
    publishStartedAt: new Date(NOW.getTime() - MINUTE),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// #6 再試行の間隔と回数
// ---------------------------------------------------------------------------

describe('publishRetryDelayMs', () => {
  /** #6。Webhook（023）と同じ 1 → 2 → 4 → 8 分。 */
  it('1 回目の失敗の後は 1 分待つ', () => {
    expect(publishRetryDelayMs(1)).toBe(60_000);
  });

  /** #6 */
  it('2 回目の失敗の後は 2 分待つ', () => {
    expect(publishRetryDelayMs(2)).toBe(120_000);
  });

  /** #6 */
  it('3 回目の失敗の後は 4 分待つ', () => {
    expect(publishRetryDelayMs(3)).toBe(240_000);
  });

  /** #6 */
  it('4 回目の失敗の後は 8 分待つ', () => {
    expect(publishRetryDelayMs(4)).toBe(480_000);
  });

  /** #6。Plugin が「もっと待て」と言ったらそれに従う（Rate Limit の Retry-After）。 */
  it('Plugin の指定が既定より長ければそちらに従う', () => {
    expect(publishRetryDelayMs(1, 900_000)).toBe(900_000);
  });

  /** #6。短い指定で既定の間隔を縮められると、相手を叩き続けることになる。 */
  it('Plugin の指定が既定より短ければ無視する', () => {
    expect(publishRetryDelayMs(4, 1_000)).toBe(480_000);
  });

  /** #6。1 件が永久に列を塞がないように上限で切り詰める。 */
  it('Plugin の指定が上限を超えたら 24 時間に切り詰める', () => {
    expect(publishRetryDelayMs(1, 48 * 60 * 60_000)).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe('canRetry', () => {
  /** #6 */
  it('4 回目まではもう一度試せる', () => {
    expect(canRetry(4)).toBe(true);
  });

  /** #6。初回 + 再試行 4 回で打ち切る。 */
  it('上限に達したらもう試さない', () => {
    expect(canRetry(PUBLISH_MAX_ATTEMPTS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #7 Plugin の戻り値を投稿の結果に写す
// ---------------------------------------------------------------------------

describe('decidePublishOutcome', () => {
  /** #7 */
  it('成功したら published にして外部 ID と URL を受け取る', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: true, externalId: 'x', externalUrl: 'https://example.com/p/1' },
      1,
      NOW,
    );

    expect(verdict).toEqual({
      kind: 'published',
      externalId: 'x',
      externalUrl: 'https://example.com/p/1',
    });
  });

  /** #7。https でない URL は履歴の導線に出せない。 */
  it('成功しても https でない外部 URL は捨てる', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: true, externalId: 'x', externalUrl: 'http://example.com/p/1' },
      1,
      NOW,
    );

    expect(verdict).toEqual({ kind: 'published', externalId: 'x', externalUrl: null });
  });

  /** #7。Web Intent のように投稿 ID を返さない配信手段がある。 */
  it('成功して外部 ID も URL も無ければ null で published にする', () => {
    const verdict = decidePublishOutcome({ type: 'result', ok: true }, 1, NOW);

    expect(verdict).toEqual({ kind: 'published', externalId: null, externalUrl: null });
  });

  /** #7。送る前に失敗したと Plugin が言ったときだけ再試行する。 */
  it('再試行できる失敗は 1 分後に予約し直す', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: false, reason: '一時的な障害', retryable: true },
      1,
      NOW,
    );

    expect(verdict).toMatchObject({
      kind: 'retry',
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });
  });

  /** #7 */
  it('再試行できる失敗の理由をそのまま残す', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: false, reason: '一時的な障害', retryable: true },
      1,
      NOW,
    );

    expect(verdict).toMatchObject({
      kind: 'retry',
      reason: expect.stringContaining('一時的な障害'),
    });
  });

  /** #7。Plugin の retryAfterMs が長ければそちらを使う。 */
  it('再試行の予約に Plugin の指定した待ち時間を使う', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: false, reason: '429', retryable: true, retryAfterMs: 900_000 },
      1,
      NOW,
    );

    expect(verdict).toMatchObject({
      kind: 'retry',
      nextAttemptAt: new Date(NOW.getTime() + 900_000),
    });
  });

  /** #7 */
  it('再試行の上限に達したら failed にする', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: false, reason: '一時的な障害', retryable: true },
      PUBLISH_MAX_ATTEMPTS,
      NOW,
    );

    expect(verdict.kind).toBe('failed');
  });

  /** #7。なぜ打ち切ったかが履歴から分かるようにする。 */
  it('再試行の上限で終わったことを理由に添える', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: false, reason: '一時的な障害', retryable: true },
      PUBLISH_MAX_ATTEMPTS,
      NOW,
    );

    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('再試行の上限'),
    });
  });

  /** #7 */
  it('再試行できない失敗は failed にする', () => {
    const verdict = decidePublishOutcome(
      { type: 'result', ok: false, reason: '本文が長すぎます', retryable: false },
      1,
      NOW,
    );

    expect(verdict).toEqual({ kind: 'failed', reason: '本文が長すぎます' });
  });

  /** #7。例外は「届いたか分からない」。二重投稿より未投稿のほうがまし。 */
  it('Plugin が例外を投げたら failed にする', () => {
    const verdict = decidePublishOutcome({ type: 'thrown', message: 'boom' }, 1, NOW);

    expect(verdict).toEqual({ kind: 'failed', reason: pluginErrorReason('boom') });
  });

  /** #7 */
  it('Plugin の例外の理由には結果不明であることを書く', () => {
    const verdict = decidePublishOutcome({ type: 'thrown', message: 'boom' }, 1, NOW);

    expect(verdict).toMatchObject({ kind: 'failed', reason: expect.stringContaining('結果不明') });
  });

  /** #7。残り回数があっても再送しない（送信済みかもしれない）。 */
  it('Plugin が例外を投げたら回数が残っていても再試行しない', () => {
    const verdict = decidePublishOutcome({ type: 'thrown', message: 'boom' }, 1, NOW);

    expect(verdict.kind).not.toBe('retry');
  });

  /** #7 */
  it('応答が返らなかったら failed にする', () => {
    const verdict = decidePublishOutcome({ type: 'timeout' }, 1, NOW);

    expect(verdict).toEqual({ kind: 'failed', reason: TIMEOUT_REASON });
  });

  /** #7 */
  it('応答が返らなかったときは回数が残っていても再試行しない', () => {
    const verdict = decidePublishOutcome({ type: 'timeout' }, 1, NOW);

    expect(verdict.kind).not.toBe('retry');
  });
});

// ---------------------------------------------------------------------------
// #8 取り出し条件
// ---------------------------------------------------------------------------

describe('isDue', () => {
  /** #8 */
  it('予約時刻の来た自動配信の投稿を取り出す', () => {
    expect(isDue(duePost(), NOW)).toBe(true);
  });

  /** #8。再試行の予定がまだ先の投稿は触らない。 */
  it('再試行の予定が先なら取り出さない', () => {
    expect(isDue(duePost({ nextAttemptAt: new Date(NOW.getTime() + SECOND) }), NOW)).toBe(false);
  });

  /** #8 */
  it('再試行の予定が過ぎていれば取り出す', () => {
    expect(isDue(duePost({ nextAttemptAt: new Date(NOW.getTime() - SECOND) }), NOW)).toBe(true);
  });

  /** #8。手動投稿はジョブが一切触らない（裁定 #3）。 */
  it('手動投稿は取り出さない', () => {
    expect(isDue(duePost({ deliveryMode: 'manual' }), NOW)).toBe(false);
  });

  /** #8 */
  it('下書きは取り出さない', () => {
    expect(isDue(duePost({ status: 'draft' }), NOW)).toBe(false);
  });

  /** #8。予約日時の無い既存行は、これまでどおり誰も取り出さない（§5.3）。 */
  it('予約日時が無ければ取り出さない', () => {
    expect(isDue(duePost({ scheduledAt: null }), NOW)).toBe(false);
  });

  /** #8。着手印が立っている＝配信が進行中。二重投稿を起こさない。 */
  it('配信が進行中の投稿は取り出さない', () => {
    expect(isDue(duePost({ publishStartedAt: new Date(NOW.getTime() - SECOND) }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #9 中断行の判定
// ---------------------------------------------------------------------------

describe('isInterrupted', () => {
  /** #9。正常に終われば着手印は必ず NULL に戻る（§5.8）。残っていれば前回が死んでいる。 */
  it('着手印が残ったままの予約投稿は中断行とみなす', () => {
    expect(isInterrupted(startedPost())).toBe(true);
  });

  /** #9 */
  it('着手印が無ければ中断行ではない', () => {
    expect(isInterrupted(startedPost({ publishStartedAt: null }))).toBe(false);
  });

  /** #9。結果が確定した投稿は中断していない。 */
  it('配信済みの投稿は中断行ではない', () => {
    expect(isInterrupted(startedPost({ status: 'published' }))).toBe(false);
  });

  /** #9。手動投稿はジョブが着手しない。 */
  it('手動投稿は中断行ではない', () => {
    expect(isInterrupted(startedPost({ deliveryMode: 'manual' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #11 資格情報の値を伏せる
// ---------------------------------------------------------------------------

describe('redactCredentialValues', () => {
  /** #11。Plugin が返した理由に資格情報が混ざっても記録に残さない。 */
  it('資格情報の値を伏せ字に置き換える', () => {
    expect(redactCredentialValues('boom s3cretpw leaked', ['s3cretpw'])).toBe('boom *** leaked');
  });

  /** #11。短い値まで置換すると、関係のない文字列を潰してしまう。 */
  it('3 文字以下の値は置き換えない', () => {
    expect(redactCredentialValues('boom ab leaked', ['ab'])).toBe('boom ab leaked');
  });

  /** #11 */
  it('伏せる値が無ければそのまま返す', () => {
    expect(redactCredentialValues('boom leaked', [])).toBe('boom leaked');
  });
});
