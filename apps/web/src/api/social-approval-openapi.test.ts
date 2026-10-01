import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';

/**
 * SNS 投稿の承認待ちの OpenAPI（048-social-post-approval 設計 §6.11、受け入れ条件 #57〜#59）。
 *
 * - #57：`createSocialPost` の要求に `publishTiming`（`enum: ['now', 'scheduled', 'after_approval']`）、
 *   `status` に `default` が無い。応答の `status` の `enum` に `awaiting_approval`、`approvedAt` が `string | null`
 * - #58：`approveSocialPost` が `POST /social/posts/{id}/approve` にあり、`x-required-permission` が `social.approve`、
 *   応答のキーが `200`・`401`・`403`・`404`・`409`・`422`・`429`・`500`
 * - #59：`listSocialPosts` の `status` クエリと `updateSocialPost` の `status` の `enum` に `awaiting_approval`
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`social-openapi.test.ts` の形）。
 */

type JsonObject = Record<string, unknown>;

interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
  readonly schema: JsonObject;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: { readonly content: Record<string, { readonly schema: JsonObject }> };
  readonly responses: Record<string, { readonly content?: Record<string, { schema: unknown }> }>;
  readonly 'x-required-permission'?: string;
}

/** 設計 §5.5 の状態（状態の進む順）。 */
const POST_STATUS_VALUES = ['draft', 'awaiting_approval', 'scheduled', 'published', 'failed'];

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

function bodyProperty(operationId: string, name: string): JsonObject {
  const schema = operation(operationId).requestBody?.content['application/json']?.schema;
  const property = findProperty(schema, name);
  if (property === undefined) throw new Error(`${operationId} の要求本文に ${name} が無い`);
  return property;
}

/** 応答（`{ data: 投稿 }`）の投稿の `<name>` の schema。 */
function responsePostProperty(operationId: string, status: string, name: string): JsonObject {
  const schema = operation(operationId).responses[status]?.content?.['application/json']?.schema;
  const post = findProperty(schema, 'data');
  const property = findProperty(post, name);
  if (property === undefined) throw new Error(`${operationId} の ${status} 応答に ${name} が無い`);
  return property;
}

/** 部分木に現れる最初の `enum`。 */
function enumOf(schema: unknown): unknown[] {
  const found = valuesOf(schema, 'enum').find(Array.isArray);
  return (found as unknown[] | undefined) ?? [];
}

/* -------------------------------------------------------------------------- */
/* #57 createSocialPost                                                          */
/* -------------------------------------------------------------------------- */

describe('#57 createSocialPost の publishTiming と応答', () => {
  it("#57 要求に publishTiming があり enum が ['now', 'scheduled', 'after_approval']", () => {
    expect(enumOf(bodyProperty('createSocialPost', 'publishTiming'))).toEqual([
      'now',
      'scheduled',
      'after_approval',
    ]);
  });

  it('#57 publishTiming は必須ではない（省略＝今の振る舞い）', () => {
    const schema = operation('createSocialPost').requestBody?.content['application/json']?.schema;
    const required = valuesOf(schema, 'required').flatMap((value) =>
      Array.isArray(value) ? value : [],
    );

    expect(required).not.toContain('publishTiming');
  });

  it('#57 publishTiming に description がある', () => {
    const descriptions = valuesOf(bodyProperty('createSocialPost', 'publishTiming'), 'description');

    expect(descriptions.join('\n')).toContain('after_approval');
  });

  it('#57 要求の status に default が無い', () => {
    expect(valuesOf(bodyProperty('createSocialPost', 'status'), 'default')).toEqual([]);
  });

  it('#57 要求の status の enum に awaiting_approval がある', () => {
    expect(enumOf(bodyProperty('createSocialPost', 'status'))).toContain('awaiting_approval');
  });

  it.each(['201', '200'])(
    '#57 %s 応答の status の enum が 5 値（awaiting_approval を含む）',
    (code) => {
      expect(enumOf(responsePostProperty('createSocialPost', code, 'status'))).toEqual(
        POST_STATUS_VALUES,
      );
    },
  );

  it.each(['201', '200'])('#57 %s 応答に approvedAt があり string | null', (code) => {
    expect(typesOf(responsePostProperty('createSocialPost', code, 'approvedAt'))).toEqual([
      'null',
      'string',
    ]);
  });

  it('#57 getSocialPost の応答にも approvedAt がある', () => {
    expect(typesOf(responsePostProperty('getSocialPost', '200', 'approvedAt'))).toEqual([
      'null',
      'string',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #59 一覧のクエリと更新の status                                                */
/* -------------------------------------------------------------------------- */

describe('#59 listSocialPosts と updateSocialPost の status の enum', () => {
  it('#59 listSocialPosts の status クエリの enum が POST_STATUSES とちょうど一致する', () => {
    const found = operation('listSocialPosts').parameters?.find(
      (candidate) => candidate.in === 'query' && candidate.name === 'status',
    );
    if (found === undefined) throw new Error('listSocialPosts に query の status が無い');

    expect(enumOf(found.schema)).toEqual(POST_STATUS_VALUES);
  });

  it('#59 updateSocialPost の status の enum が POST_STATUSES とちょうど一致する', () => {
    expect(enumOf(bodyProperty('updateSocialPost', 'status'))).toEqual(POST_STATUS_VALUES);
  });
});

describe('#78 updateSocialPost の 409（読んでから書くまでに状態が変わった）', () => {
  it('#78 応答に 409 があり、description が状態の変化を説明する', () => {
    const conflict = operation('updateSocialPost').responses['409'] as
      { readonly description?: string } | undefined;
    expect(conflict).toBeDefined();
    expect(conflict?.description).toContain('状態');
  });
});

/* -------------------------------------------------------------------------- */
/* #58 approveSocialPost                                                         */
/* -------------------------------------------------------------------------- */

describe('#58 approveSocialPost', () => {
  it('#58 POST /social/posts/{id}/approve にある', () => {
    expect(document().paths['/social/posts/{id}/approve']?.['post']?.operationId).toBe(
      'approveSocialPost',
    );
  });

  it('#58 x-required-permission が social.approve', () => {
    expect(operation('approveSocialPost')['x-required-permission']).toBe('social.approve');
  });

  it('#58 応答のキーが 200・401・403・404・409・422・429・500 ちょうど', () => {
    expect(Object.keys(operation('approveSocialPost').responses).sort()).toEqual(
      ['200', '401', '403', '404', '409', '422', '429', '500'].sort(),
    );
  });

  it("#58 要求の publishTiming の enum が ['now', 'scheduled']", () => {
    expect(enumOf(bodyProperty('approveSocialPost', 'publishTiming'))).toEqual([
      'now',
      'scheduled',
    ]);
  });

  it('#58 要求の publishTiming と expectedUpdatedAt が必須', () => {
    const schema = operation('approveSocialPost').requestBody?.content['application/json']?.schema;
    const required = valuesOf(schema, 'required').flatMap((value) =>
      Array.isArray(value) ? value : [],
    );

    expect(required).toEqual(expect.arrayContaining(['publishTiming', 'expectedUpdatedAt']));
  });

  it('#58 200 応答の投稿に approvedAt がある', () => {
    expect(typesOf(responsePostProperty('approveSocialPost', '200', 'approvedAt'))).toEqual([
      'null',
      'string',
    ]);
  });
});
