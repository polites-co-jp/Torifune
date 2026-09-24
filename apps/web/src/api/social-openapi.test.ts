import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';

/**
 * SNS の操作の OpenAPI（042-social-api-input-fixes 設計 §6.2・§6.3・§6.4）。
 *
 * - #25：一覧の `page` / `perPage` は整数で、`description` に「丸める」、`minimum` / `maximum` を書かない
 * - #32：`listSocialPosts` の `accountId` に `pattern`
 * - #33〜#36：ルートの定義で明示した追加の応答（`createSocialPost` の 200、`{id}` の 6 操作の 404、
 *   `publishSocialPosts` の 409）
 * - #37：追加の応答を書かない操作の `responses` は 042 の前の生成の規則のまま
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`openapi-coverage.test.ts` の形）。
 */

interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly schema: Record<string, unknown>;
  readonly description?: string;
}

interface OpenApiResponse {
  readonly description: string;
  readonly content?: Record<string, { readonly schema: unknown }>;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly responses: Record<string, OpenApiResponse>;
}

/** SNS の全操作（設計 §6.4 の表）。 */
const SOCIAL_OPERATIONS = [
  'listSocialAccounts',
  'createSocialAccount',
  'getSocialAccount',
  'updateSocialAccount',
  'deleteSocialAccount',
  'listSocialPosts',
  'createSocialPost',
  'getSocialPost',
  'updateSocialPost',
  'deleteSocialPost',
  'publishSocialPosts',
] as const;

/** `{id}` を持ち、404 を宣言する 6 操作（設計 §6.4）。 */
const NOT_FOUND_OPERATIONS = [
  'getSocialAccount',
  'updateSocialAccount',
  'deleteSocialAccount',
  'getSocialPost',
  'updateSocialPost',
  'deleteSocialPost',
] as const;

function operations(): readonly OpenApiOperation[] {
  const document = buildOpenApiDocument() as {
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
  };
  return Object.values(document.paths).flatMap((methods) => Object.values(methods));
}

function operation(operationId: string): OpenApiOperation {
  const found = operations().find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`OpenAPI に ${operationId} が無い`);
  return found;
}

function parameter(operationId: string, name: string): OpenApiParameter {
  const found = operation(operationId).parameters?.find(
    (candidate) => candidate.in === 'query' && candidate.name === name,
  );
  if (found === undefined) throw new Error(`${operationId} に query の ${name} が無い`);
  return found;
}

function jsonSchemaOf(response: OpenApiResponse | undefined): unknown {
  return response?.content?.['application/json']?.schema;
}

/* -------------------------------------------------------------------------- */
/* #25 page / perPage の parameter                                               */
/* -------------------------------------------------------------------------- */

describe.each(['listSocialPosts', 'listSocialAccounts'])(
  '#25 %s の page / perPage の parameter',
  (operationId) => {
    it.each(['page', 'perPage'])('#25 %s の schema.type が integer', (name) => {
      expect(parameter(operationId, name).schema['type']).toBe('integer');
    });

    it.each(['page', 'perPage'])('#25 %s の description が「丸める」を含む', (name) => {
      expect(parameter(operationId, name).description ?? '').toContain('丸める');
    });

    it.each(['page', 'perPage'])('#25 %s の schema に minimum / maximum のキーが無い', (name) => {
      const keys = Object.keys(parameter(operationId, name).schema);

      expect(keys).not.toContain('minimum');
      expect(keys).not.toContain('maximum');
    });
  },
);

/* -------------------------------------------------------------------------- */
/* #32 accountId の parameter                                                    */
/* -------------------------------------------------------------------------- */

describe('#32 listSocialPosts の accountId の parameter', () => {
  it('#32 schema に pattern がある', () => {
    expect(typeof parameter('listSocialPosts', 'accountId').schema['pattern']).toBe('string');
  });

  it('#32 pattern は大文字・小文字の UUID を受け、UUID の形でない値を受けない（設計 §6.3）', () => {
    const pattern = new RegExp(String(parameter('listSocialPosts', 'accountId').schema['pattern']));

    expect(pattern.test('0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23')).toBe(true);
    expect(pattern.test('0192B7A0-5C1E-7A3B-9F10-2D7C4E8A1B23')).toBe(true);
    expect(pattern.test('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(pattern.test('abc')).toBe(false);
    expect(pattern.test('0192b7a05c1e7a3b9f102d7c4e8a1b23')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #33 createSocialPost の 200                                                   */
/* -------------------------------------------------------------------------- */

describe('#33 createSocialPost は 201 と 200（同じ externalRef の再送）を宣言する', () => {
  it("#33 responses に '201' と '200' がある", () => {
    const { responses } = operation('createSocialPost');

    expect(responses['201']).toBeDefined();
    expect(responses['200']).toBeDefined();
  });

  it('#33 201 と 200 の schema が深く等しい', () => {
    const { responses } = operation('createSocialPost');

    expect(jsonSchemaOf(responses['201'])).toBeDefined();
    expect(jsonSchemaOf(responses['200'])).toEqual(jsonSchemaOf(responses['201']));
  });

  it('#33 200 の description が externalRef を含む', () => {
    expect(operation('createSocialPost').responses['200']?.description ?? '').toContain(
      'externalRef',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #34 {id} の 6 操作の 404                                                      */
/* -------------------------------------------------------------------------- */

describe.each(NOT_FOUND_OPERATIONS)('#34 %s は 404 を宣言する', (operationId) => {
  it("#34 responses['404'] がある", () => {
    expect(operation(operationId).responses['404']).toBeDefined();
  });

  it('#34 404 の schema が 422 の schema（エラーの形）と深く等しい', () => {
    const { responses } = operation(operationId);

    expect(jsonSchemaOf(responses['422'])).toBeDefined();
    expect(jsonSchemaOf(responses['404'])).toEqual(jsonSchemaOf(responses['422']));
  });
});

/* -------------------------------------------------------------------------- */
/* #35 publishSocialPosts の 409                                                 */
/* -------------------------------------------------------------------------- */

describe('#35 publishSocialPosts は 409 を宣言する', () => {
  it("#35 responses['409'] がある", () => {
    expect(operation('publishSocialPosts').responses['409']).toBeDefined();
  });

  it('#35 409 の description が Retry-After を含む', () => {
    expect(operation('publishSocialPosts').responses['409']?.description ?? '').toContain(
      'Retry-After',
    );
  });

  it('#35 409 の schema が 422 の schema（エラーの形）と深く等しい', () => {
    const { responses } = operation('publishSocialPosts');

    expect(jsonSchemaOf(responses['409'])).toEqual(jsonSchemaOf(responses['422']));
  });
});

/* -------------------------------------------------------------------------- */
/* #36 宣言しない操作                                                            */
/* -------------------------------------------------------------------------- */

describe('#36 404・409 を宣言しない SNS の操作', () => {
  it.each(['listSocialAccounts', 'listSocialPosts', 'createSocialAccount', 'createSocialPost'])(
    "#36 %s に '404' が無い",
    (operationId) => {
      expect(operation(operationId).responses['404']).toBeUndefined();
    },
  );

  it.each(SOCIAL_OPERATIONS.filter((operationId) => operationId !== 'publishSocialPosts'))(
    "#36 %s に '409' が無い",
    (operationId) => {
      expect(operation(operationId).responses['409']).toBeUndefined();
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #37 additionalResponses を書かない操作は変わらない                              */
/* -------------------------------------------------------------------------- */

describe('#37 追加の応答を書かない操作の responses は 042 の前の規則どおり', () => {
  it.each([
    { operationId: 'listSites', expected: ['200', '401', '403', '422', '429', '500'] },
    { operationId: 'createSite', expected: ['201', '401', '403', '422', '429', '500'] },
  ])(
    '#37 $operationId の responses のキーが従来の生成の規則どおり（追加の応答なし）',
    ({ operationId, expected }) => {
      const keys = Object.keys(operation(operationId).responses).sort();

      expect(keys).toEqual([...expected].sort());
    },
  );
});
