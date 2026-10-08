import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';
import { postResponseSchema } from './schemas/social';

/**
 * SNS 投稿の一括操作の OpenAPI（054-bulk-post-actions 設計 §8.9、受け入れ条件 #53〜#55）。
 *
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
  readonly parameters?: readonly OpenApiParameter[];
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
