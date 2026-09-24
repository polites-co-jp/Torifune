import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';

/**
 * SNS 以外の一覧のクエリの OpenAPI（043-api-input-fixes-rest 設計 §6.2・§6.3）。
 *
 * - #11：`listSites`・`listUsers`・`listCampaigns` の `page` / `perPage` は整数で、`default` が 1 / 20、
 *   `description` に「丸める」、`minimum` / `maximum` を書かない（042 と同じ形）
 * - #12：SNS の一覧（`listSocialPosts`・`listSocialAccounts`）の `page` / `perPage` の parameter が
 *   `listSites` のものと深く等しい（同じ部品を共有している）
 * - #19：`listCampaigns` の `siteId` の `schema` に `pattern` と `format: 'uuid'`
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`social-openapi.test.ts` の形）。
 */

interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly schema: Record<string, unknown>;
  readonly description?: string;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters?: readonly OpenApiParameter[];
}

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

const LIST_OPERATIONS = ['listSites', 'listUsers', 'listCampaigns'] as const;

/** 設計 §6.2：省略したときの値。 */
const DEFAULTS = { page: 1, perPage: 20 } as const;

/* -------------------------------------------------------------------------- */
/* #11 page / perPage の parameter                                               */
/* -------------------------------------------------------------------------- */

describe.each(LIST_OPERATIONS)('#11 %s の page / perPage の parameter', (operationId) => {
  it.each(['page', 'perPage'] as const)('#11 %s の schema.type が integer', (name) => {
    expect(parameter(operationId, name).schema['type']).toBe('integer');
  });

  it.each(['page', 'perPage'] as const)('#11 %s の schema.default が 1 / 20', (name) => {
    expect(parameter(operationId, name).schema['default']).toBe(DEFAULTS[name]);
  });

  it.each(['page', 'perPage'] as const)('#11 %s の description が「丸める」を含む', (name) => {
    expect(parameter(operationId, name).description ?? '').toContain('丸める');
  });

  it.each(['page', 'perPage'] as const)(
    '#11 %s の schema に minimum / maximum のキーが無い',
    (name) => {
      const keys = Object.keys(parameter(operationId, name).schema);

      expect(keys).not.toContain('minimum');
      expect(keys).not.toContain('maximum');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #12 SNS の一覧と部品を共有する                                                  */
/* -------------------------------------------------------------------------- */

describe.each(['listSocialPosts', 'listSocialAccounts'])(
  '#12 %s の page / perPage の parameter は listSites のものと深く等しい',
  (operationId) => {
    it.each(['page', 'perPage'])('#12 %s の parameter 全体が listSites と深く等しい', (name) => {
      expect(parameter(operationId, name)).toEqual(parameter('listSites', name));
    });
  },
);

/* -------------------------------------------------------------------------- */
/* #19 listCampaigns の siteId の parameter                                      */
/* -------------------------------------------------------------------------- */

describe('#19 listCampaigns の siteId の parameter', () => {
  it('#19 schema に pattern がある', () => {
    expect(typeof parameter('listCampaigns', 'siteId').schema['pattern']).toBe('string');
  });

  it("#19 schema の format が 'uuid'", () => {
    expect(parameter('listCampaigns', 'siteId').schema['format']).toBe('uuid');
  });

  it('#19 pattern は大文字・小文字の UUID を受け、UUID の形でない値を受けない（設計 §6.3）', () => {
    const pattern = new RegExp(String(parameter('listCampaigns', 'siteId').schema['pattern']));

    expect(pattern.test('0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23')).toBe(true);
    expect(pattern.test('0192B7A0-5C1E-7A3B-9F10-2D7C4E8A1B23')).toBe(true);
    expect(pattern.test('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(pattern.test('abc')).toBe(false);
    expect(pattern.test('0192b7a05c1e7a3b9f102d7c4e8a1b23')).toBe(false);
  });
});
