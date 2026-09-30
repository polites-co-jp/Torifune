import { describe, expect, it } from 'vitest';
import {
  accountResponseSchema,
  postResponseSchema,
  publishSummarySchema,
  toPostResponse,
} from '@/api/schemas/social';
import type { SocialPost } from '@/domain/social/social';
import { SKIP_REASONS } from '@/domain/social/publishing';

/**
 * SNS API の応答スキーマ（035-social-publishing 設計 §6.1.4 / §6.4 / §6.5.9、受け入れ条件 #64）。
 *
 * `openapi-coverage.test.ts` は operationId の一覧しか見ないので、
 * **項目があること自体はここで Zod スキーマを直接 `parse` して確かめる**
 * （実装プラン §8 の 7）。
 *
 * `createSocialPost` / `updateSocialPost` / `getSocialPost` / `listSocialPosts` は
 * いずれも `postResponseSchema` を応答スキーマに使うので、ここを固定すれば 4 つとも決まる。
 */

/** §6.1.4 の項目をすべて備えた応答。 */
const POST_RESPONSE = {
  id: '01930000-0000-7000-8000-000000000001',
  socialAccountId: '01930000-0000-7000-8000-000000000002',
  body: 'こんにちは',
  scheduledAt: '2026-09-23T00:00:00.000Z',
  status: 'scheduled',
  publishedAt: null,
  failedAt: null,
  failureReason: null,
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  deliveryMode: 'auto',
  media: [{ url: 'https://example.com/a.png', alt: 'a' }],
  link: 'https://example.com/lp',
  providerOptions: { replyTo: '1' },
  externalRef: 'r1',
  externalId: 'e1',
  externalUrl: 'https://x.com/a/status/1',
  attemptCount: 0,
  nextAttemptAt: null,
  // **2026-09-23 に足した（裁定 #15-a、受け入れ条件 #118）。**
  // 出さないと運用者が「あと何回で取りやめか」を知れないまま予約し直す（設計 §6.1.4）。
  skipCount: 0,
  skipReason: null,
} as const;

describe('#64 投稿の応答スキーマ（§6.1.4）', () => {
  it('#64 §6.1.4 の項目をすべて備えた応答が通る', () => {
    expect(postResponseSchema.parse({ ...POST_RESPONSE })).toMatchObject({
      deliveryMode: 'auto',
      link: 'https://example.com/lp',
      externalRef: 'r1',
      externalId: 'e1',
      externalUrl: 'https://x.com/a/status/1',
      attemptCount: 0,
      nextAttemptAt: null,
    });
  });

  it.each([
    'deliveryMode',
    'media',
    'link',
    'providerOptions',
    'externalRef',
    'externalId',
    'externalUrl',
    'attemptCount',
    'nextAttemptAt',
    'skipCount',
    'skipReason',
  ])('#64 %s が応答スキーマの項目として要求される', (key) => {
    // 項目を落としたら通らない＝スキーマが本当にその項目を持っている。
    const partial: Record<string, unknown> = { ...POST_RESPONSE };
    delete partial[key];

    expect(postResponseSchema.safeParse(partial).success, `${key} が任意になっている`).toBe(false);
  });

  it('#64 media の要素が url と alt を持つ', () => {
    const parsed = postResponseSchema.parse({ ...POST_RESPONSE });

    expect(parsed.media).toEqual([{ url: 'https://example.com/a.png', alt: 'a' }]);
  });

  it('#64 deliveryMode は auto / manual だけ', () => {
    expect(postResponseSchema.safeParse({ ...POST_RESPONSE, deliveryMode: 'later' }).success).toBe(
      false,
    );
  });

  it('#64 link / externalId / externalUrl / nextAttemptAt は null を取れる', () => {
    const parsed = postResponseSchema.parse({
      ...POST_RESPONSE,
      link: null,
      externalRef: null,
      externalId: null,
      externalUrl: null,
      nextAttemptAt: null,
    });

    expect(parsed.externalUrl).toBeNull();
  });

  it('#64 publishStartedAt / createdByTokenId は応答スキーマに無い', () => {
    // 前者は内部の進行状態、後者は他の外部アプリの Token ID（設計 §6.1.4）。
    const parsed = postResponseSchema.parse({
      ...POST_RESPONSE,
      publishStartedAt: '2026-09-23T00:00:00.000Z',
      createdByTokenId: '01930000-0000-7000-8000-000000000003',
    }) as Record<string, unknown>;

    expect(Object.keys(parsed)).not.toContain('publishStartedAt');
    expect(Object.keys(parsed)).not.toContain('createdByTokenId');
  });

  it('#64 応答スキーマに資格情報に関する項目が無い', () => {
    expect(Object.keys(postResponseSchema.shape)).not.toContain('credential');
    expect(Object.keys(postResponseSchema.shape)).not.toContain('credentials');
  });
});

/**
 * #118（2026-09-23 に足した。裁定 #15-a、設計 §6.1.4 / §6.3）。
 * **`skipCount` / `skipReason` を応答に出す。**
 *
 * 裁定 #9 は「skip 列は内部の待ち行列なので公開契約にしない」と決めたが、
 * 裁定 #14-a（予約し直しでは `skip_count` を減らさない）の結果、
 * **運用者が予約し直す前に「あと何回で取りやめか」を知る手段が無くなった**。
 * 出さないと投稿を失う（設計 §11 #24）ので覆した。
 *
 * **これは追加互換である。** 既存の項目を消しも改名もしない。
 */
describe('#118 飛ばした履歴を応答に出す（§6.1.4）', () => {
  it('#118 skipCount が数として通る', () => {
    const parsed = postResponseSchema.parse({ ...POST_RESPONSE, skipCount: 2 });

    expect(parsed.skipCount).toBe(2);
  });

  it('#118 skipCount に文字列は通らない', () => {
    expect(postResponseSchema.safeParse({ ...POST_RESPONSE, skipCount: '2' }).success).toBe(false);
  });

  it.each([...SKIP_REASONS])('#118 skipReason に %s が通る', (reason) => {
    const parsed = postResponseSchema.parse({ ...POST_RESPONSE, skipReason: reason });

    expect(parsed.skipReason).toBe(reason);
  });

  it('#118 skipReason は null を取れる（飛ばされていない投稿）', () => {
    expect(postResponseSchema.parse({ ...POST_RESPONSE, skipReason: null }).skipReason).toBeNull();
  });

  it('#118 skipReason に実装に無い値は通らない', () => {
    expect(postResponseSchema.safeParse({ ...POST_RESPONSE, skipReason: 'zzz' }).success).toBe(
      false,
    );
  });

  /**
   * **スキーマの列挙は Domain の `SKIP_REASONS` と集合として一致する。**
   * DB の CHECK との一致は #85 が別に見ているので、ここを固定すれば
   * DB → Domain → 応答の 3 つが同じ値の集合になる。
   */
  it('#118 skipReason の列挙が SKIP_REASONS と一致する', () => {
    const accepted = [...SKIP_REASONS, 'zzz', 'no_credential'].filter(
      (value) => postResponseSchema.safeParse({ ...POST_RESPONSE, skipReason: value }).success,
    );

    expect([...accepted].sort()).toEqual([...SKIP_REASONS].sort());
  });

  /** **既存の項目を消さない・改名しない**（追加互換）。増えたのはこの 2 つだけ。 */
  it('#118 応答のキー集合が既存 + skipCount / skipReason である', () => {
    expect(Object.keys(postResponseSchema.shape).sort()).toEqual(
      [
        'id',
        'socialAccountId',
        'body',
        'scheduledAt',
        'status',
        'publishedAt',
        'failedAt',
        'failureReason',
        'createdAt',
        'updatedAt',
        'deliveryMode',
        'media',
        'link',
        'providerOptions',
        'externalRef',
        'externalId',
        'externalUrl',
        'attemptCount',
        'nextAttemptAt',
        'skipCount',
        'skipReason',
      ].sort(),
    );
  });

  /** 内部の進行状態と Token ID は**引き続き**出さない（#64 の保証を弱めていない）。 */
  it('#118 publishStartedAt / createdByTokenId は依然として応答スキーマに無い', () => {
    expect(Object.keys(postResponseSchema.shape)).not.toContain('publishStartedAt');
    expect(Object.keys(postResponseSchema.shape)).not.toContain('createdByTokenId');
  });
});

/** #118。`toPostResponse` が Domain の値を**そのまま**写す（丸めない・伏せない）。 */
describe('#118 toPostResponse が飛ばした履歴を写す', () => {
  const NOW = new Date('2026-09-23T00:00:00.000Z');

  function post(overrides: Partial<SocialPost> = {}): SocialPost {
    return {
      id: '01930000-0000-7000-8000-000000000001',
      socialAccountId: '01930000-0000-7000-8000-000000000002',
      body: 'こんにちは',
      scheduledAt: NOW,
      status: 'scheduled',
      publishedAt: null,
      failedAt: null,
      failureReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      deliveryMode: 'auto',
      media: [],
      link: null,
      providerOptions: {},
      externalRef: null,
      createdByTokenId: '01930000-0000-7000-8000-000000000003',
      externalId: null,
      externalUrl: null,
      publishStartedAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      skipCount: 0,
      skipReason: null,
      ...overrides,
    };
  }

  it('#118 2 回飛ばされた投稿の skipCount / skipReason がそのまま出る', () => {
    const response = toPostResponse(post({ skipCount: 2, skipReason: 'no_publisher' }));

    expect(response.skipCount).toBe(2);
    expect(response.skipReason).toBe('no_publisher');
  });

  it('#118 飛ばされていない投稿は skipCount: 0 / skipReason: null', () => {
    const response = toPostResponse(post());

    expect(response.skipCount).toBe(0);
    expect(response.skipReason).toBeNull();
  });

  it('#118 写した応答がそのまま postResponseSchema を通る', () => {
    const response = toPostResponse(post({ skipCount: 1, skipReason: 'credential_missing' }));

    expect(postResponseSchema.parse(response).skipReason).toBe('credential_missing');
  });

  it('#118 写した応答に publishStartedAt / createdByTokenId が入らない', () => {
    const response = toPostResponse(post({ publishStartedAt: NOW }));

    expect(Object.keys(response)).not.toContain('publishStartedAt');
    expect(Object.keys(response)).not.toContain('createdByTokenId');
  });
});

describe('#64 アカウントの応答スキーマ（§6.4）', () => {
  it('#64 応答のキー集合が現行のまま（credentials を返さない）', () => {
    expect(Object.keys(accountResponseSchema.shape).sort()).toEqual(
      [
        'id',
        'provider',
        'displayName',
        'handle',
        'status',
        'credentialConfigured',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});

/** #64。`POST /api/v1/social/publish` の応答（設計 §6.5.9 / §6.5.7）。 */
describe('#64 配信の手動実行の応答スキーマ（§6.5.9）', () => {
  const SUMMARY = {
    interrupted: 0,
    due: 3,
    skipped: 1,
    // **2026-09-23 に 8 → 9 キーへ（裁定 #9）。** 「後ろへ送った」（`skipped`）と
    // 「諦めた」（`skipFailed`）を 1 つのキーにまとめない（設計 §6.5.7）。
    skipFailed: 0,
    attempted: 2,
    published: 1,
    retried: 1,
    failed: 0,
    unrecorded: 0,
  } as const;

  it('#64 publishSummarySchema が §6.5.7 の 9 キーを通す', () => {
    expect(publishSummarySchema.parse({ ...SUMMARY })).toEqual({ ...SUMMARY });
  });

  it.each([
    'interrupted',
    'due',
    'skipped',
    'skipFailed',
    'attempted',
    'published',
    'retried',
    'failed',
    'unrecorded',
  ])('#64 summary の %s が要求される', (key) => {
    const partial: Record<string, unknown> = { ...SUMMARY };
    delete partial[key];

    expect(publishSummarySchema.safeParse(partial).success, `${key} が任意になっている`).toBe(
      false,
    );
  });

  it('#64 summary は数だけ（文字列は通さない）', () => {
    // 固定キーの数値だけ。自由文は載せない（設計 §6.5.7）。
    expect(publishSummarySchema.safeParse({ ...SUMMARY, failed: 'なし' }).success).toBe(false);
  });
});
