import { describe, expect, it } from 'vitest';
import {
  accountResponseSchema,
  postResponseSchema,
  publishSummarySchema,
} from '@/api/schemas/social';

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
    attempted: 2,
    published: 1,
    retried: 1,
    failed: 0,
    unrecorded: 0,
  } as const;

  it('#64 publishSummarySchema が §6.5.7 の 8 キーを通す', () => {
    expect(publishSummarySchema.parse({ ...SUMMARY })).toEqual({ ...SUMMARY });
  });

  it.each([
    'interrupted',
    'due',
    'skipped',
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
