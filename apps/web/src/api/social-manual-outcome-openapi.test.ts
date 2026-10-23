import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { EXTERNAL_URL_MAX_LENGTH } from '@/domain/social/social';
import { buildOpenApiDocument } from './openapi';

/**
 * 手動投稿の結果 `POST /social/posts/{id}/manual-outcome` の OpenAPI（055-social-pending-tab 設計 §8.2・§8.4・§8.6、
 * 受け入れ条件 #33・#34）。
 *
 * - #33：パスと `operationId`（`recordSocialPostManualOutcome`。設計 §8.2）、`security` が `[{ session: [] }]`
 *   （Bearer を載せない）、`x-required-permission` が `social.write`、応答に 200・401・403・404・409・422・429
 *   （生成器が足す 500 は問わない。実装プラン T6）、`description` に画面専用・API トークンでは 401・外部アプリは `PATCH`
 * - #34：要求のスキーマの `outcome`（`enum` 2 つ。Domain の `ManualOutcome` と同じ順）・`expectedUpdatedAt`（必須）・
 *   `externalUrl`（任意・`null` を許す・`maxLength`）、`additionalProperties: false`
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`social-bulk-openapi.test.ts` の形）。
 * ルートはまだ無いので、未実装の段階では「OpenAPI に無い」で落ちる。
 */

type JsonObject = Record<string, unknown>;

interface OpenApiOperation {
  readonly operationId: string;
  readonly description?: string;
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly 'x-required-permission'?: string;
  readonly requestBody?: { readonly content: Record<string, { readonly schema: unknown }> };
  readonly responses: Record<string, { readonly description?: string }>;
}

const PATH = '/social/posts/{id}/manual-outcome';
const OPERATION_ID = 'recordSocialPostManualOutcome';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function document(): { readonly paths: Record<string, Record<string, OpenApiOperation>> } {
  return buildOpenApiDocument() as {
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
  };
}

function operation(): OpenApiOperation {
  const found = document().paths[PATH]?.['post'];
  if (found === undefined) throw new Error(`OpenAPI に POST ${PATH} が無い`);
  return found;
}

/** 要求本文の schema。 */
function requestSchema(): JsonObject {
  const schema = operation().requestBody?.content['application/json']?.schema;
  if (!isObject(schema)) throw new Error(`POST ${PATH} に要求本文の schema が無い`);
  return schema;
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

function bodyProperty(name: string): JsonObject {
  const property = findProperty(requestSchema(), name);
  if (property === undefined) throw new Error(`POST ${PATH} の要求本文に ${name} が無い`);
  return property;
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

function enumOf(schema: unknown): unknown[] {
  const found = valuesOf(schema, 'enum').find(Array.isArray);
  return (found as unknown[] | undefined) ?? [];
}

function typesOf(schema: unknown): string[] {
  return [
    ...new Set(
      valuesOf(schema, 'type').flatMap((value) => (Array.isArray(value) ? value : [value])),
    ),
  ]
    .map(String)
    .sort();
}

/** 要求本文の最上位の `required`。 */
function requiredOf(): string[] {
  const required = requestSchema()['required'];
  return Array.isArray(required) ? required.map(String) : [];
}

// ---------------------------------------------------------------------------
// #33 操作
// ---------------------------------------------------------------------------

describe('#33 POST /social/posts/{id}/manual-outcome', () => {
  it(`#33 POST ${PATH} があり operationId が ${OPERATION_ID}`, () => {
    expect(operation().operationId).toBe(OPERATION_ID);
  });

  it('#33 security が [{ session: [] }] ちょうど（Bearer を載せない）', () => {
    expect(operation().security).toEqual([{ session: [] }]);
  });

  it('#33 x-required-permission が social.write', () => {
    expect(operation()['x-required-permission']).toBe('social.write');
  });

  it('#33 応答に 200・401・403・404・409・422・429 がすべてある', () => {
    expect(Object.keys(operation().responses)).toEqual(
      expect.arrayContaining(['200', '401', '403', '404', '409', '422', '429']),
    );
  });

  it('#33 description に画面専用とある', () => {
    expect(operation().description ?? '').toMatch(/画面(?:（セッション）)?専用/);
  });

  it('#33 description に API トークンでは 401 とある', () => {
    expect(operation().description ?? '').toContain('API トークンでは 401');
  });

  it('#33 description に外部アプリは PATCH /social/posts/{id} を使うとある', () => {
    expect(operation().description ?? '').toContain('PATCH /social/posts/{id}');
  });
});

// ---------------------------------------------------------------------------
// #34 要求のスキーマ
// ---------------------------------------------------------------------------

describe('#34 manual-outcome の要求のスキーマ', () => {
  it("#34 outcome の enum が ['posted', 'not_posted']（ManualOutcome と同じ順）", () => {
    expect(enumOf(bodyProperty('outcome'))).toEqual(['posted', 'not_posted']);
  });

  it('#34 outcome と expectedUpdatedAt が必須', () => {
    expect(requiredOf()).toEqual(expect.arrayContaining(['outcome', 'expectedUpdatedAt']));
  });

  it('#34 externalUrl は必須でない', () => {
    expect(requiredOf()).not.toContain('externalUrl');
  });

  it('#34 externalUrl は文字列か null', () => {
    expect(typesOf(bodyProperty('externalUrl'))).toEqual(['null', 'string']);
  });

  it(`#34 externalUrl の maxLength が ${EXTERNAL_URL_MAX_LENGTH}`, () => {
    expect(valuesOf(bodyProperty('externalUrl'), 'maxLength')).toContain(EXTERNAL_URL_MAX_LENGTH);
  });

  it('#34 要求本文が additionalProperties: false（未知のキーを断る）', () => {
    expect(requestSchema()['additionalProperties']).toBe(false);
  });
});
