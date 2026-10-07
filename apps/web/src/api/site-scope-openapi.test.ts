import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';

/**
 * SNS アカウントと API トークンをサイトに紐づける件の OpenAPI（053-site-scoped-social 設計 §8.8）。
 *
 * - #57：`createApiToken` の要求に `siteId`、`listApiTokens` / `createApiToken` の応答に `siteId` と `siteScoped`（boolean）（G3）
 * - #56：`getSocialAccount` の応答の `data` に `siteId`（`string`・`nullable`）。`createSocialAccount` /
 *   `updateSocialAccount` の要求に `siteId`（`nullable`・必須でない）（G4）
 * - #59：`getSocialPost` の 404 の `description` が「このトークンからは見えない」を含む（設計 §8.8 のとおり
 *   `updateSocialPost` / `deleteSocialPost` / `approveSocialPost` も）。投稿の応答のキー集合は変わらない（G5）
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`social-approval-openapi.test.ts` の形）。
 */

type JsonObject = Record<string, unknown>;

interface OpenApiOperation {
  readonly operationId: string;
  readonly requestBody?: { readonly content: Record<string, { readonly schema: JsonObject }> };
  readonly responses: Record<
    string,
    { readonly description?: string; readonly content?: Record<string, { schema: unknown }> }
  >;
  readonly 'x-required-permission'?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function document(): { readonly paths: Record<string, Record<string, OpenApiOperation>> } {
  return buildOpenApiDocument() as {
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
  };
}

function operation(operationId: string): OpenApiOperation {
  const found = Object.values(document().paths)
    .flatMap((methods) => Object.values(methods))
    .find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`OpenAPI に ${operationId} が無い`);
  return found;
}

/** schema の中（`anyOf` / `oneOf` / `allOf` の枝、配列の `items` を含む）から `properties.<name>` を探す。 */
function findProperty(schema: unknown, name: string): JsonObject | undefined {
  if (!isObject(schema)) return undefined;
  const properties = schema['properties'];
  if (isObject(properties) && isObject(properties[name])) {
    return properties[name];
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const found = findProperty(branch, name);
        if (found !== undefined) return found;
      }
    }
  }
  if (isObject(schema['items'])) {
    return findProperty(schema['items'], name);
  }
  return undefined;
}

/** schema の部分木に現れる `key` の値をすべて集める（`anyOf` の枝に付く場合も拾う）。 */
function valuesOf(schema: unknown, key: string): unknown[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item) => valuesOf(item, key));
  }
  if (!isObject(schema)) return [];
  const own = key in schema ? [schema[key]] : [];
  return [...own, ...Object.values(schema).flatMap((value) => valuesOf(value, key))];
}

/** 部分木に現れる `type` を平らにした集合（`type: ['string', 'null']` と `anyOf` の両方を拾う）。 */
function typesOf(schema: unknown): string[] {
  return [
    ...new Set(
      valuesOf(schema, 'type').flatMap((value) => (Array.isArray(value) ? value : [value])),
    ),
  ]
    .map(String)
    .sort();
}

function requestSchema(operationId: string): JsonObject | undefined {
  return operation(operationId).requestBody?.content['application/json']?.schema;
}

function bodyProperty(operationId: string, name: string): JsonObject {
  const property = findProperty(requestSchema(operationId), name);
  if (property === undefined) throw new Error(`${operationId} の要求本文に ${name} が無い`);
  return property;
}

/** 要求本文の `required` に現れる名前（`anyOf` の枝のものも含む）。 */
function requiredOf(operationId: string): unknown[] {
  return valuesOf(requestSchema(operationId), 'required').flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
}

/** 応答（`{ data: … }`）の `data`（一覧なら要素）の `<name>` の schema。 */
function responseDataProperty(operationId: string, status: string, name: string): JsonObject {
  const schema = operation(operationId).responses[status]?.content?.['application/json']?.schema;
  const data = findProperty(schema, 'data');
  const property = findProperty(data, name);
  if (property === undefined) throw new Error(`${operationId} の ${status} 応答に ${name} が無い`);
  return property;
}

/* -------------------------------------------------------------------------- */
/* #57 createApiToken / listApiTokens                                            */
/* -------------------------------------------------------------------------- */

describe('#57 API トークンの siteId / siteScoped', () => {
  it('#57 createApiToken の要求に siteId があり string | null', () => {
    expect(typesOf(bodyProperty('createApiToken', 'siteId'))).toEqual(['null', 'string']);
  });

  it('#57 createApiToken の要求の siteId は必須でない（省略は共通のトークン）', () => {
    expect(requiredOf('createApiToken')).not.toContain('siteId');
  });

  it.each([
    ['listApiTokens', '200'],
    ['createApiToken', '201'],
  ])('#57 %s の %s 応答に siteId があり string | null', (operationId, status) => {
    expect(typesOf(responseDataProperty(operationId, status, 'siteId'))).toEqual([
      'null',
      'string',
    ]);
  });

  it.each([
    ['listApiTokens', '200'],
    ['createApiToken', '201'],
  ])('#57 %s の %s 応答に siteScoped があり boolean', (operationId, status) => {
    expect(typesOf(responseDataProperty(operationId, status, 'siteScoped'))).toEqual(['boolean']);
  });

  it('#57 listApiTokens の応答に平文（token）が無い（変えない）', () => {
    const schema =
      operation('listApiTokens').responses['200']?.content?.['application/json']?.schema;

    expect(findProperty(findProperty(schema, 'data'), 'token')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #56 SNS アカウントの siteId                                                    */
/* -------------------------------------------------------------------------- */

describe('#56 SNS アカウントの siteId', () => {
  it('#56 getSocialAccount の 200 応答の data に siteId があり string | null', () => {
    expect(typesOf(responseDataProperty('getSocialAccount', '200', 'siteId'))).toEqual([
      'null',
      'string',
    ]);
  });

  it.each(['createSocialAccount', 'updateSocialAccount'])(
    '#56 %s の要求に siteId があり string | null',
    (operationId) => {
      expect(typesOf(bodyProperty(operationId, 'siteId'))).toEqual(['null', 'string']);
    },
  );

  it.each(['createSocialAccount', 'updateSocialAccount'])(
    '#56 %s の要求の siteId は必須でない',
    (operationId) => {
      expect(requiredOf(operationId)).not.toContain('siteId');
    },
  );

  it.each([
    ['listSocialAccounts', '200'],
    ['createSocialAccount', '201'],
    ['updateSocialAccount', '200'],
  ])('#56 %s の %s 応答の data にも siteId がある', (operationId, status) => {
    expect(typesOf(responseDataProperty(operationId, status, 'siteId'))).toEqual([
      'null',
      'string',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #59 SNS 投稿の 404 と応答の形                                                   */
/* -------------------------------------------------------------------------- */

/** 053 の時点の投稿の応答のキー（設計 §8.8：投稿の応答は変えない）。 */
const POST_RESPONSE_KEYS = [
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
  'approvedAt',
];

/** 応答（`{ data: … }`）の `data` の `properties` のキー（昇順）。 */
function responseDataKeys(operationId: string, status: string): string[] {
  const schema = operation(operationId).responses[status]?.content?.['application/json']?.schema;
  const data = findProperty(schema, 'data');
  const properties = isObject(data) ? data['properties'] : undefined;
  if (!isObject(properties)) throw new Error(`${operationId} の ${status} 応答に data が無い`);
  return Object.keys(properties).sort();
}

describe('#59 SNS 投稿の 404 の説明と、投稿の応答の形', () => {
  it("#59 getSocialPost の responses['404'] の description が「このトークンからは見えない」を含む", () => {
    expect(operation('getSocialPost').responses['404']?.description ?? '').toContain(
      'このトークンからは見えない',
    );
  });

  it.each(['updateSocialPost', 'deleteSocialPost', 'approveSocialPost'])(
    "#59 %s の responses['404'] の description も「このトークンからは見えない」を含む（設計 §8.8）",
    (operationId) => {
      expect(operation(operationId).responses['404']?.description ?? '').toContain(
        'このトークンからは見えない',
      );
    },
  );

  it.each([
    ['getSocialPost', '200'],
    ['createSocialPost', '201'],
  ])(
    '#59 %s の %s 応答の data のキー集合は変わらない（siteId・origin_* を出さない）',
    (operationId, status) => {
      expect(responseDataKeys(operationId, status)).toEqual([...POST_RESPONSE_KEYS].sort());
    },
  );

  it('#59 getSocialPost の応答に siteId が無い', () => {
    const schema =
      operation('getSocialPost').responses['200']?.content?.['application/json']?.schema;

    expect(findProperty(findProperty(schema, 'data'), 'siteId')).toBeUndefined();
  });
});
