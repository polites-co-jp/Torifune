import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';
import { createCampaignSchema, updateCampaignSchema } from './schemas/campaign';

/**
 * キャンペーンの紐づけ先の上限と説明の OpenAPI・Zod（045-campaign-input-500 設計 §4・§6.1、受け入れ条件 #29・#30）。
 *
 * - #29：`createCampaign`・`updateCampaign` の要求本文の `siteIds` / `socialPostIds` が `maxItems: 1000` と、
 *   `UUID` と `1000` を含む `description` を持つ。`listCampaigns` の `activeOn` の `description` が「存在しない日付」を含む
 * - #30：`createCampaignSchema` の件数の誤りのキーは `siteIds`（`siteIds.0` ではない。画面の欄に出せるキー）
 *
 * 実際に登録されているエンドポイント（`@/api/endpoints`）から作った文書を見る（`list-query-openapi.test.ts` の形）。
 */

const ID = '0192b7a0-5c1e-7a3b-8f10-2d7c4e8a1b23';

interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
  readonly schema: Record<string, unknown>;
  readonly description?: string;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly content: Record<string, { readonly schema: Record<string, unknown> }>;
  };
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

/** 要求本文の `properties.<name>` の schema。 */
function bodyProperty(operationId: string, name: string): Record<string, unknown> {
  const schema = operation(operationId).requestBody?.content['application/json']?.schema as
    { readonly properties?: Record<string, Record<string, unknown>> } | undefined;
  const property = schema?.properties?.[name];
  if (property === undefined) throw new Error(`${operationId} の要求本文に ${name} が無い`);
  return property;
}

function queryParameter(operationId: string, name: string): OpenApiParameter {
  const found = operation(operationId).parameters?.find(
    (candidate) => candidate.in === 'query' && candidate.name === name,
  );
  if (found === undefined) throw new Error(`${operationId} に query の ${name} が無い`);
  return found;
}

const CASES = [
  ['createCampaign', 'siteIds'],
  ['createCampaign', 'socialPostIds'],
  ['updateCampaign', 'siteIds'],
  ['updateCampaign', 'socialPostIds'],
] as const;

/* -------------------------------------------------------------------------- */
/* #29 OpenAPI                                                                    */
/* -------------------------------------------------------------------------- */

describe('#29 要求本文の siteIds / socialPostIds に上限と説明がある', () => {
  it.each(CASES)('#29 %s の %s の schema が maxItems: 1000 を持つ', (operationId, name) => {
    expect(bodyProperty(operationId, name)['maxItems']).toBe(1000);
  });

  it.each(CASES)('#29 %s の %s の description が UUID を含む', (operationId, name) => {
    expect(String(bodyProperty(operationId, name)['description'] ?? '')).toContain('UUID');
  });

  it.each(CASES)('#29 %s の %s の description が 1000 を含む', (operationId, name) => {
    expect(String(bodyProperty(operationId, name)['description'] ?? '')).toContain('1000');
  });
});

describe('#29 listCampaigns の activeOn に説明がある', () => {
  it('#29 activeOn の parameter の description が「存在しない日付」を含む', () => {
    expect(queryParameter('listCampaigns', 'activeOn').description ?? '').toContain(
      '存在しない日付',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #30 Zod の件数の誤りのキー                                                         */
/* -------------------------------------------------------------------------- */

describe('#30 createCampaignSchema の件数の上限', () => {
  const base = { name: 'キャンペーン', startsOn: '2026-01-01' };

  it('#30 siteIds に 1000 個 → 成功', () => {
    const result = createCampaignSchema.safeParse({
      ...base,
      siteIds: Array.from({ length: 1000 }, () => ID),
    });

    expect(result.success).toBe(true);
  });

  it('#30 siteIds に 1001 個 → 失敗', () => {
    const result = createCampaignSchema.safeParse({
      ...base,
      siteIds: Array.from({ length: 1001 }, () => ID),
    });

    expect(result.success).toBe(false);
  });

  it('#30 siteIds に 1001 個 → 問題のキーが siteIds だけ（siteIds.0 ではない）', () => {
    const result = createCampaignSchema.safeParse({
      ...base,
      siteIds: Array.from({ length: 1001 }, () => ID),
    });

    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['siteIds']);
  });

  it('#30 siteIds に 1001 個 → 文言が「1000件以内で指定してください。」', () => {
    const result = createCampaignSchema.safeParse({
      ...base,
      siteIds: Array.from({ length: 1001 }, () => ID),
    });

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      '1000件以内で指定してください。',
    ]);
  });

  it('#30 socialPostIds に 1001 個 → 問題のキーが socialPostIds だけ', () => {
    const result = createCampaignSchema.safeParse({
      ...base,
      socialPostIds: Array.from({ length: 1001 }, () => ID),
    });

    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['socialPostIds']);
  });

  it('#30 updateCampaignSchema も siteIds に 1001 個 → 問題のキーが siteIds だけ', () => {
    const result = updateCampaignSchema.safeParse({
      siteIds: Array.from({ length: 1001 }, () => ID),
    });

    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['siteIds']);
  });

  it("#30 要素の形は Zod で見ない（siteIds: ['abc'] は Zod を通り、UseCase が 422 にする）", () => {
    const result = createCampaignSchema.safeParse({ ...base, siteIds: ['abc'] });

    expect(result.success).toBe(true);
  });
});
