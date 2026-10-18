import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { BULK_EFFECTS, BULK_FAILURE_REASONS, BULK_MAX_ITEMS } from '@/domain/social/bulk';
import { buildOpenApiDocument } from './openapi';
import { postResponseSchema } from './schemas/social';

/**
 * SNS 投稿の一括操作の OpenAPI（054-bulk-post-actions 設計 §8.9、受け入れ条件 #53〜#55）。
 *
 * - #53：一括の 3 操作（`bulkApproveSocialPosts`・`bulkPublishSocialPostsNow`・`bulkDeleteSocialPosts`）のパスと
 *   `x-required-permission`、`security` が `[{ session: [] }]`（Bearer を載せない）、応答のキーがちょうど
 *   `200`・`401`・`403`・`422`・`429`・`500`、`description` に「画面（セッション）専用」「API トークンでは 401」（G7）
 * - #54：要求の `items` / `ids` に `minItems: 1`・`maxItems: 100`、`publishTiming` の `enum` が `['now', 'scheduled']`。
 *   応答の `results` の要素（`ok` で分かれる 2 つの枝）の `reason` / `effect` の `enum` が Domain の定数と順まで一致し、
 *   `post` が `null` を許す（G7）
 * - #55：`listSocialPosts` のクエリのパラメータと、投稿の応答（`postResponseSchema`）のキーは 054 の前（`4597907`）と
 *   同じ（`source`・`createdByTokenName` が無い）（G1）
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`site-scope-openapi.test.ts` の形）。
 */

type JsonObject = Record<string, unknown>;

interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly description?: string;
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly 'x-required-permission'?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: { readonly content: Record<string, { readonly schema: unknown }> };
  readonly responses: Record<
    string,
    { readonly description?: string; readonly content?: Record<string, { schema: unknown }> }
  >;
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

/** schema の中（`anyOf` / `oneOf` / `allOf` の枝を含む）から `properties.<name>` を探す。 */
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
  return undefined;
}

/**
 * 応答（`{ data: … }`）の `data` の `properties` のキー（昇順）。`data` が配列（一覧）なら要素の `properties`。
 */
function responseDataKeys(operationId: string, status: string): string[] {
  const schema = operation(operationId).responses[status]?.content?.['application/json']?.schema;
  const data = findProperty(schema, 'data');
  const target = isObject(data) && isObject(data['items']) ? data['items'] : data;
  const properties = isObject(target) ? target['properties'] : undefined;
  if (!isObject(properties)) throw new Error(`${operationId} の ${status} 応答に data が無い`);
  return Object.keys(properties).sort();
}

/** 054 の前（`4597907`）の `listSocialPosts` のクエリのパラメータ（設計 §5.6・§8.7：登録元を足さない）。 */
const LIST_POSTS_QUERY_054 = ['accountId', 'page', 'perPage', 'status'];

/** 054 の前（`4597907`）の投稿の応答のキー（設計 §7.3：`createdByTokenName` を出さない）。 */
const POST_RESPONSE_KEYS_054 = [
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

function listPostsQueryNames(): string[] {
  return (operation('listSocialPosts').parameters ?? [])
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name)
    .sort();
}

describe('#55 listSocialPosts のクエリと投稿の応答のキーは 054 の前と同じ', () => {
  it('#55 listSocialPosts のクエリのパラメータの名前の集合が 054 の前と同じ', () => {
    expect(listPostsQueryNames()).toEqual(LIST_POSTS_QUERY_054);
  });

  it('#55 listSocialPosts のクエリに source（登録元の絞り込み）が無い', () => {
    expect(listPostsQueryNames().some((name) => /source/i.test(name))).toBe(false);
  });

  it('#55 listSocialPosts の 200 の data の要素の properties のキーが 054 の前と同じ', () => {
    expect(responseDataKeys('listSocialPosts', '200')).toEqual([...POST_RESPONSE_KEYS_054].sort());
  });

  it.each([
    ['getSocialPost', '200'],
    ['createSocialPost', '201'],
  ])('#55 %s の %s の data の properties のキーが 054 の前と同じ', (operationId, status) => {
    expect(responseDataKeys(operationId, status)).toEqual([...POST_RESPONSE_KEYS_054].sort());
  });

  it('#55 postResponseSchema のキーが 054 の前と同じで、createdByTokenName が無い', () => {
    const keys = Object.keys(postResponseSchema.shape);

    expect([...keys].sort()).toEqual([...POST_RESPONSE_KEYS_054].sort());
    expect(keys).not.toContain('createdByTokenName');
  });

  it('#55 判別力：createdByTokenName を足したキー集合は固定と一致しない', () => {
    expect([...POST_RESPONSE_KEYS_054, 'createdByTokenName'].sort()).not.toEqual(
      [...POST_RESPONSE_KEYS_054].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #53・#54 一括の 3 操作（G7）                                                   */
/* -------------------------------------------------------------------------- */

/** 設計 §8.9 の表：operationId・パス・`x-required-permission`。 */
const BULK_OPERATIONS = [
  ['bulkApproveSocialPosts', '/social/posts/bulk/approve', 'social.approve'],
  ['bulkPublishSocialPostsNow', '/social/posts/bulk/publish-now', 'social.write'],
  ['bulkDeleteSocialPosts', '/social/posts/bulk/delete', 'social.delete'],
] as const;

const BULK_OPERATION_IDS = BULK_OPERATIONS.map(([operationId]) => operationId);

/** 一括の操作の要求の配列の名前（承認と今すぐ送るは `items`、取り消しは `ids`。設計 §8.2〜§8.4）。 */
const BULK_ARRAY_FIELDS = [
  ['bulkApproveSocialPosts', 'items'],
  ['bulkPublishSocialPostsNow', 'items'],
  ['bulkDeleteSocialPosts', 'ids'],
] as const;

/** 設計 §8.9 の応答（404・409 は宣言しない）。 */
const BULK_RESPONSE_STATUSES = ['200', '401', '403', '422', '429', '500'];

/** 設計 §8.9 の `security`：画面（セッション）専用。 */
const SESSION_ONLY_SECURITY = [{ session: [] }];

/** operationId から、その操作が載っているパスとメソッドを引く。 */
function locate(operationId: string): { readonly path: string; readonly method: string } {
  for (const [path, methods] of Object.entries(document().paths)) {
    for (const [method, candidate] of Object.entries(methods)) {
      if (candidate.operationId === operationId) return { path, method };
    }
  }
  throw new Error(`OpenAPI に ${operationId} が無い`);
}

/** schema の部分木に現れる `key` の値をすべて集める（`anyOf` / `oneOf` の枝に付く場合も拾う）。 */
function valuesOf(schema: unknown, key: string): unknown[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item) => valuesOf(item, key));
  }
  if (!isObject(schema)) return [];
  const own = key in schema ? [schema[key]] : [];
  return [...own, ...Object.values(schema).flatMap((value) => valuesOf(value, key))];
}

/** 部分木に現れる最初の `enum`。 */
function enumOf(schema: unknown): unknown[] {
  const found = valuesOf(schema, 'enum').find(Array.isArray);
  return (found as unknown[] | undefined) ?? [];
}

/** 部分木に現れる `type` を平らにした集合（`type: ['object', 'null']` と `anyOf` の両方を拾う）。 */
function typesOf(schema: unknown): string[] {
  return [
    ...new Set(
      valuesOf(schema, 'type').flatMap((value) => (Array.isArray(value) ? value : [value])),
    ),
  ]
    .map(String)
    .sort();
}

/** 要求本文の `properties.<name>`。 */
function bodyProperty(operationId: string, name: string): JsonObject {
  const schema = operation(operationId).requestBody?.content['application/json']?.schema;
  const property = findProperty(schema, name);
  if (property === undefined) throw new Error(`${operationId} の要求本文に ${name} が無い`);
  return property;
}

/** 200 の応答の `data.results` の要素の schema。 */
function resultElement(operationId: string): JsonObject {
  const schema = operation(operationId).responses['200']?.content?.['application/json']?.schema;
  const results = findProperty(findProperty(schema, 'data'), 'results');
  const element = results?.['items'];
  if (!isObject(element)) throw new Error(`${operationId} の 200 応答に data.results の要素が無い`);
  return element;
}

/** 要素の `ok` で分かれる枝（`oneOf` か `anyOf`。実装プラン §8 の 22）。 */
function resultBranches(operationId: string): JsonObject[] {
  const element = resultElement(operationId);
  const branches = element['oneOf'] ?? element['anyOf'];
  return Array.isArray(branches) ? branches.filter(isObject) : [];
}

/** 結果の要素の `<name>` の schema（どちらの枝にあってもよい）。 */
function resultProperty(operationId: string, name: string): JsonObject {
  const property = findProperty(resultElement(operationId), name);
  if (property === undefined) throw new Error(`${operationId} の results の要素に ${name} が無い`);
  return property;
}

/** `security` が画面（セッション）専用とちょうど同じか（Bearer を載せていないか）。 */
function isSessionOnly(security: unknown): boolean {
  return JSON.stringify(security) === JSON.stringify(SESSION_ONLY_SECURITY);
}

/** 応答のキーの集合が設計 §8.9 とちょうど同じか。 */
function hasExactlyBulkResponses(statuses: readonly string[]): boolean {
  return JSON.stringify([...statuses].sort()) === JSON.stringify(BULK_RESPONSE_STATUSES);
}

/** `enum` が Domain の定数と順まで一致するか。 */
function sameEnum(actual: readonly unknown[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

describe('#53 一括の 3 操作のパス・権限・認証・応答', () => {
  it.each(BULK_OPERATIONS)('#53 %s が POST %s にある', (operationId, path) => {
    expect(locate(operationId)).toEqual({ path, method: 'post' });
  });

  it.each(BULK_OPERATIONS)(
    '#53 %s（%s）の x-required-permission が %s',
    (operationId, _path, permission) => {
      expect(operation(operationId)['x-required-permission']).toBe(permission);
    },
  );

  it.each(BULK_OPERATION_IDS)(
    '#53 %s の security が [{ session: [] }]（Bearer を載せない）',
    (id) => {
      const security = operation(id).security;

      expect(security).toEqual(SESSION_ONLY_SECURITY);
      expect(isSessionOnly(security)).toBe(true);
    },
  );

  it.each(BULK_OPERATION_IDS)(
    '#53 %s の応答のキーがちょうど 200・401・403・422・429・500（404・409 は無い）',
    (operationId) => {
      const statuses = Object.keys(operation(operationId).responses);

      expect([...statuses].sort()).toEqual(BULK_RESPONSE_STATUSES);
      expect(hasExactlyBulkResponses(statuses)).toBe(true);
    },
  );

  it.each(BULK_OPERATION_IDS)(
    '#53 %s の description に「画面（セッション）専用」「API トークンでは 401」がある',
    (operationId) => {
      const description = operation(operationId).description ?? '';

      expect(description).toContain('画面（セッション）専用');
      expect(description).toContain('API トークンでは 401');
    },
  );

  it('#53 判別力：security に bearer を足した写しは画面専用と読まない', () => {
    const security = operation('bulkApproveSocialPosts').security ?? [];

    expect(isSessionOnly([...security, { bearer: [] }])).toBe(false);
    expect(isSessionOnly([{ session: [] }, { bearer: [] }])).toBe(false);
  });

  it('#53 判別力：404 を足した写し・429 を落とした写しは応答のキーの固定と一致しない', () => {
    const statuses = Object.keys(operation('bulkApproveSocialPosts').responses);

    expect(hasExactlyBulkResponses([...statuses, '404'])).toBe(false);
    expect(hasExactlyBulkResponses(statuses.filter((status) => status !== '429'))).toBe(false);
  });
});

describe('#54 一括の 3 操作の要求と応答の schema', () => {
  it.each(BULK_ARRAY_FIELDS)('#54 %s の要求の %s に minItems: 1・maxItems: 100', (id, field) => {
    const property = bodyProperty(id, field);

    expect(typesOf(property)).toContain('array');
    expect([...new Set(valuesOf(property, 'minItems'))]).toEqual([1]);
    expect([...new Set(valuesOf(property, 'maxItems'))]).toEqual([100]);
  });

  it('#54 maxItems の 100 は BULK_MAX_ITEMS と同じ値', () => {
    expect(BULK_MAX_ITEMS).toBe(100);
  });

  it("#54 bulkApproveSocialPosts の要求の publishTiming の enum が ['now', 'scheduled']", () => {
    expect(enumOf(bodyProperty('bulkApproveSocialPosts', 'publishTiming'))).toEqual([
      'now',
      'scheduled',
    ]);
  });

  it.each(BULK_OPERATION_IDS)(
    '#54 %s の results の要素は ok で分かれる 2 つの枝（ok: true と ok: false）',
    (operationId) => {
      const branches = resultBranches(operationId);
      const oks = branches.map((branch) => valuesOf(findProperty(branch, 'ok'), 'const')[0]);

      expect(branches).toHaveLength(2);
      expect([...oks].sort()).toEqual([false, true]);
    },
  );

  it.each(BULK_OPERATION_IDS)(
    '#54 %s の results の要素の reason の enum が BULK_FAILURE_REASONS と順まで一致',
    (operationId) => {
      const reasons = enumOf(resultProperty(operationId, 'reason'));

      expect(reasons).toEqual([...BULK_FAILURE_REASONS]);
      expect(sameEnum(reasons, BULK_FAILURE_REASONS)).toBe(true);
    },
  );

  it.each(BULK_OPERATION_IDS)(
    '#54 %s の results の要素の effect の enum が BULK_EFFECTS と順まで一致',
    (operationId) => {
      const effects = enumOf(resultProperty(operationId, 'effect'));

      expect(effects).toEqual([...BULK_EFFECTS]);
      expect(sameEnum(effects, BULK_EFFECTS)).toBe(true);
    },
  );

  it.each(BULK_OPERATION_IDS)('#54 %s の results の要素の post は null を許す', (operationId) => {
    const types = typesOf(resultProperty(operationId, 'post'));

    expect(types).toContain('null');
    expect(types).toContain('object');
  });

  it('#54 判別力：enum を 1 つ落とした写し・並びを入れ替えた写しは Domain の定数と一致しない', () => {
    const reasons = enumOf(resultProperty('bulkApproveSocialPosts', 'reason'));
    const effects = enumOf(resultProperty('bulkApproveSocialPosts', 'effect'));

    expect(sameEnum(reasons.slice(0, -1), BULK_FAILURE_REASONS)).toBe(false);
    expect(sameEnum(effects.slice(1), BULK_EFFECTS)).toBe(false);
    expect(sameEnum([...reasons].reverse(), BULK_FAILURE_REASONS)).toBe(false);
  });
});
