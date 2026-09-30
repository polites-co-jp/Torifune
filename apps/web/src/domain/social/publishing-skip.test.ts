import { describe, expect, it } from 'vitest';
import {
  checkPublisherLimits,
  decideSkipOutcome,
  PUBLISH_MAX_SKIPS,
  skipFailureReason,
  skipRetryDelayMs,
} from './publishing';

/**
 * 配信できない予約を後ろへ送る判定と、配信直前の再検査に使う純関数
 * （035-social-publishing 設計 §5.6.2、受け入れ条件 #86、#87 の (A)。裁定 #9 / S-2）。
 *
 * **Domain 層の単体テスト。** DB も外部 API も時計も使わない。
 * `now` は引数で渡し、テストの中で固定する（`publishing.test.ts` と同じ流儀）。
 *
 * ここは `publishing.test.ts` とは別ファイルにする。2026-09-23 の改訂で足した
 * 関数だけをまとめ、既存の条件（#6〜#11）と混ぜない。
 */

const NOW = new Date('2026-09-22T10:00:00.000Z');
const HOUR = 60 * 60_000;

/** `decideSkipOutcome` が受ける投稿の形。公開された引数の形だけに依存する。 */
type SkipState = Parameters<typeof decideSkipOutcome>[0];
/** `checkPublisherLimits` が受ける投稿の形。 */
type LimitsPost = Parameters<typeof checkPublisherLimits>[0];

function skipState(overrides: Partial<SkipState> = {}): SkipState {
  return { skipCount: 0, skipReason: null, ...overrides };
}

function limitsPost(overrides: Partial<LimitsPost> = {}): LimitsPost {
  return { body: '本文', media: [], deliveryMode: 'auto', ...overrides };
}

function media(count: number): { readonly url: string; readonly alt: string | null }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    url: `https://example.com/${index}.png`,
    alt: null,
  }));
}

// ---------------------------------------------------------------------------
// #86 後ろへ送る回数と間隔
// ---------------------------------------------------------------------------

describe('PUBLISH_MAX_SKIPS', () => {
  /** #86。**3 回目で `failed`。** 丸一日待って支度が整わなければ諦める（設計 §5.6.2）。 */
  it('同じ理由で飛ばしてよいのは 3 回まで', () => {
    expect(PUBLISH_MAX_SKIPS).toBe(3);
  });
});

describe('skipRetryDelayMs', () => {
  /** #86。1 分周期で 3 回数えると 3 分で諦めてしまう。1 時間空ける。 */
  it('1 回目を飛ばした後は 1 時間待つ', () => {
    expect(skipRetryDelayMs(1)).toBe(3_600_000);
  });

  /** #86。合計およそ 24 時間の猶予にする（裁定 #9 の細目）。 */
  it('2 回目を飛ばした後は 23 時間待つ', () => {
    expect(skipRetryDelayMs(2)).toBe(82_800_000);
  });

  /** #86。範囲外は末尾の値（設計 §5.6.2）。 */
  it('表に無い回数では末尾の待ち時間を使う', () => {
    expect(skipRetryDelayMs(3)).toBe(82_800_000);
  });
});

describe('decideSkipOutcome', () => {
  /** #86。まだ一度も飛ばしていない投稿。 */
  it('初めて飛ばす投稿は 1 回目として 1 時間後へ送る', () => {
    const verdict = decideSkipOutcome(skipState(), 'no_publisher', NOW);

    expect(verdict).toEqual({
      kind: 'deferred',
      skipCount: 1,
      reason: 'no_publisher',
      nextAttemptAt: new Date(NOW.getTime() + HOUR),
    });
  });

  /** #86 */
  it('同じ理由で 2 回目に飛ばす投稿は 23 時間後へ送る', () => {
    const verdict = decideSkipOutcome(
      skipState({ skipCount: 1, skipReason: 'no_publisher' }),
      'no_publisher',
      NOW,
    );

    expect(verdict).toEqual({
      kind: 'deferred',
      skipCount: 2,
      reason: 'no_publisher',
      nextAttemptAt: new Date(NOW.getTime() + 23 * HOUR),
    });
  });

  /** #86。**3 回目は諦める。** 順番待ちから外さないと他のアカウントの配信が止まる（S-1）。 */
  it('同じ理由で 3 回目に飛ばす投稿は failed にする', () => {
    const verdict = decideSkipOutcome(
      skipState({ skipCount: 2, skipReason: 'no_publisher' }),
      'no_publisher',
      NOW,
    );

    expect(verdict).toEqual({
      kind: 'failed',
      skipCount: 3,
      reason: 'no_publisher',
      failureReason: skipFailureReason('no_publisher'),
    });
  });

  /**
   * #86。**理由が変われば数え直す**（裁定 #9 の細目）。
   *
   * 「publisher が無い → 入った → 今度は資格情報が無い」は別の事象で、
   * 運用者は 1 つずつ直している最中である。まとめて数えると途中で打ち切られる。
   */
  it('前と違う理由で飛ばすときは 1 回目から数え直す', () => {
    const verdict = decideSkipOutcome(
      skipState({ skipCount: 2, skipReason: 'no_publisher' }),
      'credential_missing',
      NOW,
    );

    expect(verdict).toEqual({
      kind: 'deferred',
      skipCount: 1,
      reason: 'credential_missing',
      nextAttemptAt: new Date(NOW.getTime() + HOUR),
    });
  });
});

describe('skipFailureReason', () => {
  /** #86。`failure_reason` は投稿一覧・履歴にそのまま出る。次にすべきことが読めること。 */
  it.each(['no_publisher', 'credential_missing', 'account_missing'] as const)(
    '%s の文言が登録し直す手順を含む',
    (reason) => {
      expect(skipFailureReason(reason)).toContain('登録し直して');
    },
  );

  /** #86。何が足りなかったのかが分かること。 */
  it('no_publisher の文言が Plugin に触れている', () => {
    expect(skipFailureReason('no_publisher')).toContain('Plugin');
  });

  /** #86 */
  it('credential_missing の文言が資格情報に触れている', () => {
    expect(skipFailureReason('credential_missing')).toContain('資格情報');
  });
});

// ---------------------------------------------------------------------------
// #87 publisher の宣言に照らした判定（登録時と配信直前で同じ関数を使う）
// ---------------------------------------------------------------------------

describe('checkPublisherLimits', () => {
  /** #87 */
  it('本文が上限を超えたら body の問題を返す', () => {
    const problems = checkPublisherLimits(
      limitsPost({ body: 'a'.repeat(11) }),
      { bodyMaxLength: 10 },
      'テストSNS',
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: 'body' });
  });

  /** #87。上限ちょうどは通る（境界）。 */
  it('本文が上限ちょうどなら問題を返さない', () => {
    expect(
      checkPublisherLimits(
        limitsPost({ body: 'a'.repeat(10) }),
        { bodyMaxLength: 10 },
        'テストSNS',
      ),
    ).toEqual([]);
  });

  /** #87。文言から「何文字までか」「どの SNS の話か」が分かること（設計 §6.1.2 の j）。 */
  it('本文の問題の文言に上限と publisher の表示名が入る', () => {
    const problems = checkPublisherLimits(
      limitsPost({ body: 'a'.repeat(11) }),
      { bodyMaxLength: 10 },
      'テストSNS',
    );

    expect(problems[0]?.message).toContain('10');
    expect(problems[0]?.message).toContain('テストSNS');
  });

  /** #87 */
  it('媒体が上限を超えたら media の問題を返す', () => {
    const problems = checkPublisherLimits(
      limitsPost({ media: media(3) }),
      { mediaMax: 2 },
      'テストSNS',
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: 'media' });
  });

  /** #87。媒体が必須の SNS（Instagram）。 */
  it('媒体が必須の自動配信で媒体が無ければ media の問題を返す', () => {
    const problems = checkPublisherLimits(
      limitsPost({ media: [], deliveryMode: 'auto' }),
      { mediaRequired: true },
      'テストSNS',
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: 'media' });
  });

  /** #87。**手動投稿には掛けない**（手動投稿はそもそも媒体を持てない。設計 §6.1.2 の f・l）。 */
  it('媒体が必須でも手動投稿には掛けない', () => {
    expect(
      checkPublisherLimits(
        limitsPost({ media: [], deliveryMode: 'manual' }),
        { mediaRequired: true },
        'テストSNS',
      ),
    ).toEqual([]);
  });

  /** #87。何も宣言していない publisher は何も弾かない。 */
  it('limits が空なら問題を返さない', () => {
    expect(checkPublisherLimits(limitsPost({ body: 'a'.repeat(999) }), {}, 'テストSNS')).toEqual(
      [],
    );
  });

  /**
   * #87。**複数違反はすべて返る。**
   *
   * UseCase は先頭 1 件だけを `ValidationError` にするが（設計 §6.1.2 の枠）、
   * 配信直前の再検査は理由にすべて並べる（§6.5.2.2）。関数は落とさない。
   */
  it('本文と媒体の両方が違反していれば 2 件返る', () => {
    const problems = checkPublisherLimits(
      limitsPost({ body: 'a'.repeat(11), media: media(3) }),
      { bodyMaxLength: 10, mediaMax: 2 },
      'テストSNS',
    );

    expect(problems.map((problem) => problem.field).sort()).toEqual(['body', 'media']);
  });
});
