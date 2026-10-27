import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';

/**
 * 手動投稿の投稿画面の URL `GET /social/posts/{id}/manual-handoff` の OpenAPI（057-social-bulk-post 設計 §6、受け入れ条件 #49）。
 *
 * * パスと `operationId`（`getSocialPostManualHandoff`）、`security` が `[{ session: [] }]`（Bearer を載せない）、
 *   `x-required-permission` が `social.read`、応答に 200・401・403・404・422・429（生成器が足す 500 は問わない）
 * * `description` に「画面（セッション）専用」
 * * 200 の `data` が `ok` で分かれる 2 つの形（`ok: true` は `url`・`note`、`ok: false` は `reason` の `enum` が 4 つ）
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`social-manual-outcome-openapi.test.ts` の形）。
 * ルートはまだ無いので、未実装の段階では「OpenAPI に無い」で落ちる。
 */

type JsonObject = Record<string, unknown>;

interface OpenApiOperation {
  readonly operationId: string;
  readonly description?: string;
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly 'x-required-permission'?: string;
  readonly requestBody?: unknown;
  readonly responses: Record<
    string,
    {
      readonly description?: string;
      readonly content?: Record<string, { readonly schema?: unknown }>;
    }
  >;
}

const PATH = '/social/posts/{id}/manual-handoff';
const OPERATION_ID = 'getSocialPostManualHandoff';
const REASONS = ['unsupported', 'invalid_url', 'plugin_error', 'not_scheduled'];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Document {
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components?: { readonly schemas?: Record<string, unknown> };
}

function document(): Document {
  return buildOpenApiDocument() as unknown as Document;
}

function operation(): OpenApiOperation {
  const found = document().paths[PATH]?.['get'];
  if (found === undefined) throw new Error(`OpenAPI に GET ${PATH} が無い`);
  return found;
}

/** `$ref` を components から引いて解く（1 段ずつ、循環しない範囲）。 */
function resolve(schema: unknown, depth = 0): unknown {
  if (!isObject(schema) || depth > 10) return schema;
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    return resolve(document().components?.schemas?.[name], depth + 1);
  }
  return schema;
}

/** 200 の応答の schema の `data`。 */
function dataSchema(): JsonObject {
  const schema = resolve(operation().responses['200']?.content?.['application/json']?.schema);
  if (!isObject(schema)) throw new Error(`GET ${PATH} の 200 に schema が無い`);
  const properties = schema['properties'];
  const data = isObject(properties) ? resolve(properties['data']) : undefined;
  if (!isObject(data)) throw new Error(`GET ${PATH} の 200 に data が無い`);
  return data;
}

/** `oneOf` / `anyOf` の枝（`$ref` を解いたもの）。 */
function branchesOf(schema: JsonObject): JsonObject[] {
  const branches = schema['oneOf'] ?? schema['anyOf'];
  if (!Array.isArray(branches)) return [];
  return branches.map((branch) => resolve(branch)).filter(isObject);
}

function propertiesOf(schema: JsonObject): JsonObject {
  const properties = schema['properties'];
  return isObject(properties) ? properties : {};
}

/** 枝の `ok` の値（`const` か 1 つだけの `enum`）。 */
function okOf(branch: JsonObject): unknown {
  const ok = resolve(propertiesOf(branch)['ok']);
  if (!isObject(ok)) return undefined;
  if ('const' in ok) return ok['const'];
  const values = ok['enum'];
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
}

function branchWithOk(value: boolean): JsonObject {
  const found = branchesOf(dataSchema()).find((branch) => okOf(branch) === value);
  if (found === undefined) throw new Error(`data に ok: ${String(value)} の枝が無い`);
  return found;
}

describe('#49 GET /social/posts/{id}/manual-handoff の OpenAPI', () => {
  it(`#49 GET ${PATH} があり operationId が ${OPERATION_ID}`, () => {
    expect(operation().operationId).toBe(OPERATION_ID);
  });

  it('#49 security が [{ session: [] }] ちょうど（Bearer を載せない）', () => {
    expect(operation().security).toEqual([{ session: [] }]);
  });

  it('#49 x-required-permission が social.read', () => {
    expect(operation()['x-required-permission']).toBe('social.read');
  });

  it('#49 応答に 200・401・403・404・422・429 がすべてある', () => {
    expect(Object.keys(operation().responses)).toEqual(
      expect.arrayContaining(['200', '401', '403', '404', '422', '429']),
    );
  });

  it('#49 要求本文が無い（GET）', () => {
    expect(operation().requestBody).toBeUndefined();
  });

  it('#49 description に「画面（セッション）専用」とある', () => {
    expect(operation().description ?? '').toContain('画面（セッション）専用');
  });

  it('#49 description に API トークンでは 401・not_scheduled とある', () => {
    expect(operation().description ?? '').toContain('API トークンでは 401');
    expect(operation().description ?? '').toContain('not_scheduled');
  });

  it('#49 200 の data は ok で分かれる 2 つの形', () => {
    const branches = branchesOf(dataSchema());

    expect(branches).toHaveLength(2);
    expect(branches.map(okOf).sort()).toEqual([false, true]);
  });

  it('#49 ok: true の形は ok・url・note（url は文字列、note は文字列か null）', () => {
    const properties = propertiesOf(branchWithOk(true));

    expect(Object.keys(properties).sort()).toEqual(['note', 'ok', 'url']);
    expect(JSON.stringify(resolve(properties['url']))).toContain('"string"');
    expect(JSON.stringify(resolve(properties['note']))).toContain('"null"');
  });

  it("#49 ok: false の形は ok・reason で、reason の enum が 4 つ（'unsupported'・'invalid_url'・'plugin_error'・'not_scheduled'）", () => {
    const properties = propertiesOf(branchWithOk(false));
    const reason = resolve(properties['reason']);

    expect(Object.keys(properties).sort()).toEqual(['ok', 'reason']);
    expect(isObject(reason) ? [...(reason['enum'] as unknown[])].sort() : []).toEqual(
      [...REASONS].sort(),
    );
  });

  it('#49 2 つの形はどちらも additionalProperties: false（strict）', () => {
    expect(branchWithOk(true)['additionalProperties']).toBe(false);
    expect(branchWithOk(false)['additionalProperties']).toBe(false);
  });
});
