import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument } from './openapi';
import { resetEndpointRegistry } from './registry';
import { defineRoute, RouteDefinitionError } from './route';

/**
 * `additionalResponses` の `status: 401`（043-api-input-fixes-rest 設計 §6.4、受け入れ条件 #36・#37）。
 *
 * - #36：`permission` が `null` でない操作に `status: 401` を書くと `RouteDefinitionError`
 *   （生成器が既に 401 を出している。二重に書くと description が上書きされ、どちらが正か分からなくなる）。
 *   `permission: null`（`reason` あり）なら投げない
 * - #37：`permission: null` の操作に書いた 401 は、`responses['401']` に書いた description で出て、
 *   本文の形は 422 と同じエラーの形になる
 *
 * 投げない側の定義は登録簿に残るので、実物の文書を見るテストとは別のファイルにし、
 * `afterEach` で登録簿を空に戻す（`route-additional-responses.test.ts` と同じ）。`operationId` はこのテスト専用の名前にする。
 */

afterEach(() => {
  resetEndpointRegistry();
});

const UNAUTHORIZED_DESCRIPTION = 'テスト用：ログイン ID またはパスワードが正しくない';

interface OpenApiResponse {
  readonly description: string;
  readonly content?: Record<string, { readonly schema: unknown }>;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly responses: Record<string, OpenApiResponse>;
}

function operation(operationId: string): OpenApiOperation {
  const document = buildOpenApiDocument() as {
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
  };
  const found = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`OpenAPI に ${operationId} が無い`);
  return found;
}

function jsonSchemaOf(response: OpenApiResponse | undefined): unknown {
  return response?.content?.['application/json']?.schema;
}

/** 認可のある操作に 401 を書く。 */
function defineWithPermission(operationId: string): void {
  defineRoute({
    operationId,
    method: 'GET',
    path: `/test-043/${operationId}`,
    summary: '043 の 401 の検査',
    permission: 'site.read',
    additionalResponses: [{ status: 401, description: UNAUTHORIZED_DESCRIPTION }],
    handler: async () => new Response(null, { status: 204 }),
  });
}

/** 認可の無い操作に 401 を書く。 */
function defineWithoutPermission(operationId: string): void {
  defineRoute({
    operationId,
    method: 'POST',
    path: `/test-043/${operationId}`,
    summary: '043 の 401 の検査',
    permission: null,
    reason: 'テスト専用の定義',
    body: z.object({ loginId: z.string() }),
    additionalResponses: [{ status: 401, description: UNAUTHORIZED_DESCRIPTION }],
    handler: async () => new Response(null, { status: 204 }),
  });
}

describe('#36 認可のある操作に 401 を書くと RouteDefinitionError', () => {
  it("#36 permission: 'site.read' の操作に status: 401 → 投げる", () => {
    expect(() => defineWithPermission('test043UnauthorizedWithPermission')).toThrow(
      RouteDefinitionError,
    );
  });

  it('#36 permission: null（reason あり）の操作に status: 401 → 投げない', () => {
    expect(() => defineWithoutPermission('test043UnauthorizedWithoutPermission')).not.toThrow();
  });
});

describe('#37 認可の無い操作に書いた 401 が OpenAPI に出る', () => {
  it("#37 responses['401'].description が書いた値", () => {
    defineWithoutPermission('test043UnauthorizedDescription');

    expect(operation('test043UnauthorizedDescription').responses['401']?.description).toBe(
      UNAUTHORIZED_DESCRIPTION,
    );
  });

  it("#37 responses['401'] の schema が responses['422'] のもの（エラーの形）と深く等しい", () => {
    defineWithoutPermission('test043UnauthorizedSchema');
    const { responses } = operation('test043UnauthorizedSchema');

    expect(jsonSchemaOf(responses['422'])).toBeDefined();
    expect(jsonSchemaOf(responses['401'])).toEqual(jsonSchemaOf(responses['422']));
  });
});
