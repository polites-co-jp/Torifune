import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetEndpointRegistry } from './registry';
import { defineRoute, RouteDefinitionError } from './route';

/**
 * `defineRoute` の `additionalResponses` の定義の誤りを起動時に見つける
 * （042-social-api-input-fixes 設計 §6.4、受け入れ条件 #38）。
 *
 * 次のそれぞれで `RouteDefinitionError` を投げる。
 *
 * - (a) `status` が `successStatus`（既定 200）と同じ
 * - (b) 同じ `status` が 2 回ある
 * - (c) `status: 200` なのに `response` が無い
 *
 * 投げない側の定義は登録簿に残るので、実物の文書を見る `social-openapi.test.ts` とは別のファイルにし、
 * `afterEach` で登録簿を空に戻す（042 実装プラン §7 の 11）。`operationId` はこのテスト専用の名前にする。
 */

const responseSchema = z.object({ data: z.object({ id: z.string() }) });

afterEach(() => {
  resetEndpointRegistry();
});

/** `additionalResponses` の要素。 */
interface AdditionalResponse {
  readonly status: 200 | 404 | 409;
  readonly description: string;
}

interface Variant {
  readonly operationId: string;
  readonly successStatus?: 200 | 201;
  readonly withResponse: boolean;
  readonly additionalResponses: readonly AdditionalResponse[];
}

function define(variant: Variant): void {
  defineRoute({
    operationId: variant.operationId,
    method: 'POST',
    path: `/test-042/${variant.operationId}`,
    summary: '042 の追加の応答の検査',
    permission: null,
    reason: 'テスト専用の定義',
    ...(variant.successStatus === undefined ? {} : { successStatus: variant.successStatus }),
    ...(variant.withResponse ? { response: responseSchema } : {}),
    additionalResponses: variant.additionalResponses,
    handler: async () => new Response(null, { status: 204 }),
  });
}

describe('#38 additionalResponses の定義の誤りは RouteDefinitionError', () => {
  it('#38 (a) successStatus を省略（200）して status: 200 を足す → 投げる', () => {
    expect(() =>
      define({
        operationId: 'test042SameAsDefaultSuccess',
        withResponse: true,
        additionalResponses: [{ status: 200, description: '成功と同じ' }],
      }),
    ).toThrow(RouteDefinitionError);
  });

  it('#38 (a) successStatus: 200 を明示して status: 200 を足す → 投げる', () => {
    expect(() =>
      define({
        operationId: 'test042SameAsExplicitSuccess',
        successStatus: 200,
        withResponse: true,
        additionalResponses: [{ status: 200, description: '成功と同じ' }],
      }),
    ).toThrow(RouteDefinitionError);
  });

  it('#38 (b) 同じ status（404）が 2 回 → 投げる', () => {
    expect(() =>
      define({
        operationId: 'test042DuplicatedStatus',
        successStatus: 201,
        withResponse: true,
        additionalResponses: [
          { status: 404, description: '見つからない' },
          { status: 404, description: 'もう一度' },
        ],
      }),
    ).toThrow(RouteDefinitionError);
  });

  it('#38 (c) successStatus: 201・response なしで status: 200 → 投げる', () => {
    expect(() =>
      define({
        operationId: 'test042OkWithoutResponse',
        successStatus: 201,
        withResponse: false,
        additionalResponses: [{ status: 200, description: '再送' }],
      }),
    ).toThrow(RouteDefinitionError);
  });
});

describe('#38 正しい定義は投げない', () => {
  it('#38 successStatus: 201・response ありで status: 200 → 投げない', () => {
    expect(() =>
      define({
        operationId: 'test042OkWithResponse',
        successStatus: 201,
        withResponse: true,
        additionalResponses: [{ status: 200, description: '再送' }],
      }),
    ).not.toThrow();
  });

  it('#38（b の対照）違う status（404 と 409）を並べる → 投げない', () => {
    expect(() =>
      define({
        operationId: 'test042DistinctStatuses',
        withResponse: true,
        additionalResponses: [
          { status: 404, description: '見つからない' },
          { status: 409, description: '競合' },
        ],
      }),
    ).not.toThrow();
  });
});
