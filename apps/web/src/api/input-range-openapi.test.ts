import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { ACCESS_LOG_PRUNE_MAX_DAYS } from '@/domain/analytics/analytics';
import { buildOpenApiDocument } from './openapi';

/**
 * 範囲の OpenAPI への反映（046-input-500-nul-and-ranges 設計 §6.1・§6.5・§6.6、受け入れ条件 #46）。
 *
 * - `rollupAnalytics` の要求本文の `pruneOlderThanDays` が `maximum: 36500` を持つ（B4）
 * - `createSocialPost`・`updateSocialPost` の `scheduledAt` の `description` が範囲（`0001` と `9999`）を書いている（B3）
 * - `ACCESS_LOG_PRUNE_MAX_DAYS === 36500`
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`campaign-openapi.test.ts` の形）。
 * `rollupAnalytics` の本文は省略できる（`.optional()`）ので、`properties` が `anyOf` などの枝の中にあっても拾う。
 */

type JsonObject = Record<string, unknown>;

interface OpenApiOperation {
  readonly operationId: string;
  readonly requestBody?: {
    readonly content: Record<string, { readonly schema: JsonObject }>;
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** 要求本文の `<name>` の schema。 */
function bodyProperty(operationId: string, name: string): JsonObject {
  const schema = operation(operationId).requestBody?.content['application/json']?.schema;
  const property = findProperty(schema, name);
  if (property === undefined) throw new Error(`${operationId} の要求本文に ${name} が無い`);
  return property;
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

function descriptionOf(schema: JsonObject): string {
  return valuesOf(schema, 'description')
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

describe('#46 rollupAnalytics の pruneOlderThanDays の上限', () => {
  it('#46 要求本文の pruneOlderThanDays が maximum: 36500 を持つ', () => {
    expect(valuesOf(bodyProperty('rollupAnalytics', 'pruneOlderThanDays'), 'maximum')).toContain(
      36500,
    );
  });

  it('#46 ACCESS_LOG_PRUNE_MAX_DAYS === 36500', () => {
    expect(ACCESS_LOG_PRUNE_MAX_DAYS).toBe(36500);
  });
});

describe('#46 scheduledAt の description が範囲を書いている', () => {
  it.each(['createSocialPost', 'updateSocialPost'])(
    '#46 %s の scheduledAt の description が 0001 を含む',
    (operationId) => {
      expect(descriptionOf(bodyProperty(operationId, 'scheduledAt'))).toContain('0001');
    },
  );

  it.each(['createSocialPost', 'updateSocialPost'])(
    '#46 %s の scheduledAt の description が 9999 を含む',
    (operationId) => {
      expect(descriptionOf(bodyProperty(operationId, 'scheduledAt'))).toContain('9999');
    },
  );
});
