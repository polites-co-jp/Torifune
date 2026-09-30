import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';
import { listDocumentedEndpoints, type EndpointSpec } from './registry';

/**
 * SNS 以外の操作の OpenAPI の追加の応答（043-api-input-fixes-rest 設計 §6.4、受け入れ条件 #38〜#41）。
 *
 * - #38：設計 §6.4 の表の 404 / 409 / 401 の本文の形が、それぞれの操作の 422 と同じエラーの形
 * - #39：**網羅**。全公開操作の `responses` から「生成器が出すもの」を除いた集合が、
 *   設計 §6.4 の表と 042 §6.4 の表に書いた追加の応答とちょうど一致する（表に無い操作は空集合）
 * - #40：description の要点（`Retry-After`、ログイン ID、UUID の形でない ID を含む）
 * - #41：パスに `{id}` を持つ公開操作は、すべて 404 を宣言する
 *
 * 「生成器が出すもの」は `responses` から逆算せず、登録簿の `EndpointSpec` から計算する（実装プラン §8 の 12）：
 * 成功（`successStatus ?? 200`）、422・429・500、`permission` があれば 401・403、GET 以外は 403。
 *
 * **操作を足したら、この表も更新する。** 宣言の要否を必ず判断させるための意図した手間である（設計 §13 の 3）。
 */

interface OpenApiResponse {
  readonly description: string;
  readonly content?: Record<string, { readonly schema: unknown }>;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly responses: Record<string, OpenApiResponse>;
}

/** 設計 §6.4 の表（SNS 以外の 27 操作）：操作 ID → 追加の status。 */
const REST_ADDITIONAL: Readonly<Record<string, readonly number[]>> = {
  getSite: [404],
  updateSite: [404],
  deleteSite: [404],
  regenerateSitePublicKey: [404],
  getUser: [404],
  deleteUser: [404],
  updateUser: [404, 409],
  createUser: [409],
  getCampaign: [404],
  updateCampaign: [404],
  deleteCampaign: [404],
  revokeApiToken: [404],
  deleteWebhook: [404],
  getPluginOperation: [404],
  installPlugin: [404],
  enablePlugin: [404],
  disablePlugin: [404],
  uninstallPlugin: [404],
  installFromRegistry: [404],
  getPluginSettings: [404],
  savePluginSettings: [404],
  deliverWebhooks: [409],
  rollupAnalytics: [409],
  login: [401],
  confirmPasswordReset: [401],
  getCurrentUser: [401],
  completeSetup: [404, 409],
};

/** 042 §6.4 の表（SNS の 8 操作）：操作 ID → 追加の status。043 では変えない。 */
const SOCIAL_ADDITIONAL: Readonly<Record<string, readonly number[]>> = {
  createSocialPost: [200],
  getSocialAccount: [404],
  updateSocialAccount: [404],
  deleteSocialAccount: [404],
  getSocialPost: [404],
  updateSocialPost: [404],
  deleteSocialPost: [404],
  publishSocialPosts: [409],
};

const ADDITIONAL: Readonly<Record<string, readonly number[]>> = {
  ...REST_ADDITIONAL,
  ...SOCIAL_ADDITIONAL,
};

function document(): { readonly paths: Record<string, Record<string, OpenApiOperation>> } {
  return buildOpenApiDocument() as {
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
  };
}

function operations(): readonly OpenApiOperation[] {
  return Object.values(document().paths).flatMap((methods) => Object.values(methods));
}

function operation(operationId: string): OpenApiOperation {
  const found = operations().find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`OpenAPI に ${operationId} が無い`);
  return found;
}

function jsonSchemaOf(response: OpenApiResponse | undefined): unknown {
  return response?.content?.['application/json']?.schema;
}

/** 生成器が出す status（`EndpointSpec` から計算する）。 */
function generatedStatusesOf(endpoint: EndpointSpec): Set<string> {
  const statuses = new Set([String(endpoint.successStatus ?? 200), '422', '429', '500']);
  if (endpoint.permission !== null) {
    statuses.add('401');
    statuses.add('403');
  }
  if (endpoint.method !== 'GET') {
    statuses.add('403');
  }
  return statuses;
}

/** OpenAPI の `responses` から、生成器が出すものを除いた status（昇順）。 */
function additionalStatusesOf(endpoint: EndpointSpec): string[] {
  const generated = generatedStatusesOf(endpoint);
  return Object.keys(operation(endpoint.operationId).responses)
    .filter((status) => !generated.has(status))
    .sort();
}

/* -------------------------------------------------------------------------- */
/* #38 追加の応答の本文の形                                                        */
/* -------------------------------------------------------------------------- */

const REST_ERROR_RESPONSES = Object.entries(REST_ADDITIONAL).flatMap(([operationId, statuses]) =>
  statuses.map((status) => ({ operationId, status: String(status) })),
);

describe('#38 設計 §6.4 の表の 404 / 409 / 401 はエラーの形', () => {
  it.each(REST_ERROR_RESPONSES)(
    '#38 $operationId の $status の schema が 422 のもの（エラーの形）と深く等しい',
    ({ operationId, status }) => {
      const { responses } = operation(operationId);

      expect(responses[status], `${operationId} に ${status} が無い`).toBeDefined();
      expect(jsonSchemaOf(responses['422'])).toBeDefined();
      expect(jsonSchemaOf(responses[status])).toEqual(jsonSchemaOf(responses['422']));
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #39 網羅                                                                      */
/* -------------------------------------------------------------------------- */

describe('#39 全公開操作の追加の応答が表とちょうど一致する', () => {
  it('#39 表は設計 §6.4 の 27 操作と 042 の 8 操作の計 35 行', () => {
    expect(Object.keys(REST_ADDITIONAL)).toHaveLength(27);
    expect(Object.keys(SOCIAL_ADDITIONAL)).toHaveLength(8);
    expect(Object.keys(ADDITIONAL)).toHaveLength(35);
  });

  it('#39 表の操作はすべて文書に載っている公開操作', () => {
    const documented = new Set(listDocumentedEndpoints().map((endpoint) => endpoint.operationId));

    expect(Object.keys(ADDITIONAL).filter((operationId) => !documented.has(operationId))).toEqual(
      [],
    );
  });

  it('#39 公開操作は 65 で、表の 35 と何も足さない 30 に分かれる', () => {
    const endpoints = listDocumentedEndpoints();
    const withoutAdditional = endpoints.filter(
      (endpoint) => ADDITIONAL[endpoint.operationId] === undefined,
    );

    expect(endpoints).toHaveLength(65);
    expect(withoutAdditional).toHaveLength(30);
  });

  it.each(listDocumentedEndpoints().map((endpoint) => ({ operationId: endpoint.operationId })))(
    '#39 $operationId の追加の応答が表のとおり（表に無ければ空）',
    ({ operationId }) => {
      const endpoint = listDocumentedEndpoints().find(
        (candidate) => candidate.operationId === operationId,
      );
      if (endpoint === undefined) throw new Error(`登録簿に ${operationId} が無い`);
      const expected = (ADDITIONAL[operationId] ?? []).map(String).sort();

      expect(additionalStatusesOf(endpoint)).toEqual(expected);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #40 description                                                              */
/* -------------------------------------------------------------------------- */

describe('#40 追加の応答の description', () => {
  it.each(['deliverWebhooks', 'rollupAnalytics'])(
    "#40 %s の responses['409'] の description が Retry-After を含む",
    (operationId) => {
      expect(operation(operationId).responses['409']?.description ?? '').toContain('Retry-After');
    },
  );

  it("#40 createUser の responses['409'] の description がログイン ID を含む", () => {
    expect(operation('createUser').responses['409']?.description ?? '').toContain('ログイン ID');
  });

  it.each(['revokeApiToken', 'deleteWebhook', 'getPluginOperation'])(
    "#40 %s の responses['404'] の description が「UUID の形でない ID を含む」を含む",
    (operationId) => {
      expect(operation(operationId).responses['404']?.description ?? '').toContain(
        'UUID の形でない ID を含む',
      );
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #41 {id} を持つ操作は 404 を宣言する                                             */
/* -------------------------------------------------------------------------- */

describe('#41 パスに {id} を持つ公開操作はすべて 404 を宣言する', () => {
  const WITH_ID = Object.entries(document().paths)
    .filter(([path]) => path.includes('{id}'))
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, candidate]) => ({
        path,
        method: method.toUpperCase(),
        operationId: candidate.operationId,
      })),
    );

  it('#41 対象の操作がある（検査が空回りしていない）', () => {
    expect(WITH_ID.length).toBeGreaterThan(0);
  });

  it.each(WITH_ID)(
    "#41 $method $path（$operationId）に responses['404'] がある",
    ({ operationId }) => {
      expect(operation(operationId).responses['404']).toBeDefined();
    },
  );
});
