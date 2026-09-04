import { describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { buildOpenApiDocument } from './openapi';
import { listDocumentedEndpoints } from './registry';

/**
 * 実際に登録されているエンドポイントに対する OpenAPI の網羅状況（05_API設計.md §40）。
 *
 * **応答スキーマの宣言は任意にしてある。** 全エンドポイントへ一度に付けると
 * 差分が大きくなりすぎるため、主要な資源 API（Site / User / Campaign / SNS /
 * API Token / Analytics / 認証）から付けている。
 *
 * ここで「未宣言のもの」を名前で固定する。
 * **新しいエンドポイントを未宣言のまま足すと、このテストが落ちる。**
 * 宣言を増やしたときも落ちるので、そのつど一覧を削る。
 */

/** 応答スキーマがまだ無いエンドポイント。**減らす方向にだけ動かす。** */
const RESPONSE_SCHEMA_PENDING = [
  'completeSetup',
  'createWebhook',
  'deliverWebhooks',
  'disablePlugin',
  'enablePlugin',
  'getPluginOperation',
  'getPluginSettings',
  'getSystemSettings',
  'inspectPluginPackage',
  'installFromRegistry',
  'installPlugin',
  'installPluginPackage',
  'listPermissions',
  'listPlugins',
  'listRegistryPlugins',
  'listRoles',
  'listWebhooks',
  'login',
  'rollupAnalytics',
  'savePluginSettings',
  'uninstallPlugin',
  'updateSystemSettings',
];

describe('応答スキーマの網羅', () => {
  it('未宣言のエンドポイントは一覧のとおり', () => {
    const pending = listDocumentedEndpoints()
      .filter(
        // 204 は本文を返さないので「未宣言」ではない。
        (endpoint) => endpoint.responseSchema === undefined && endpoint.successStatus !== 204,
      )
      .map((endpoint) => endpoint.operationId)
      .sort();

    expect(pending).toEqual([...RESPONSE_SCHEMA_PENDING].sort());
  });

  it('主要な資源 API には応答スキーマがある', () => {
    const declared = new Set(
      listDocumentedEndpoints()
        .filter((endpoint) => endpoint.responseSchema !== undefined)
        .map((endpoint) => endpoint.operationId),
    );

    for (const operationId of [
      'listSites',
      'getSite',
      'createSite',
      // 028 設計 §6.6（受け入れ条件 #48 の静的側）。
      'regenerateSitePublicKey',
      'listUsers',
      'getUser',
      'createUser',
      'listCampaigns',
      'getCampaign',
      'listSocialAccounts',
      'listSocialPosts',
      'listApiTokens',
      'createApiToken',
      'listAnalytics',
      // 028 設計 §6.2（受け入れ条件 #39 の静的側）。
      'listAnalyticsBreakdown',
      'getCurrentUser',
      'issueCsrfToken',
      // 029 設計 §6.5（受け入れ条件 #41 の静的側）。監視から叩くので応答の形を宣言する。
      'listJobStatuses',
    ]) {
      expect(declared, operationId).toContain(operationId);
    }
  });
});

describe('認証の宣言と実態', () => {
  it('認可が要るエンドポイントには必ず security が付く', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };

    for (const endpoint of listDocumentedEndpoints()) {
      const operation = document.paths[endpoint.path]?.[endpoint.method.toLowerCase()];
      if (endpoint.permission === null) {
        expect(operation?.security, endpoint.operationId).toBeUndefined();
      } else {
        expect(operation?.security, endpoint.operationId).toBeDefined();
      }
    }
  });

  /**
   * Token から Token を作れると Scope の意味が無くなる（021-api-token 設計 §5）。
   * 実装が Bearer を拒む口は、仕様でも Cookie だけと宣言していなければならない。
   */
  it('API Token の管理 API は Cookie だけと宣言する', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };

    expect(document.paths['/api-tokens']?.['post']?.security).toEqual([{ session: [] }]);
    expect(document.paths['/api-tokens/{id}']?.['delete']?.security).toEqual([{ session: [] }]);
    // 一覧は Token 認証でも呼べる。
    expect(document.paths['/api-tokens']?.['get']?.security).toEqual([
      { session: [] },
      { bearer: [] },
    ]);
  });
});

describe('非推奨', () => {
  /**
   * 現時点で非推奨のエンドポイントは無い。
   * **足したらここが落ちる。** 落ちたら、移行先と削除予定日が書かれているかを確かめる。
   */
  it('非推奨のエンドポイントは無い', () => {
    const deprecated = listDocumentedEndpoints()
      .filter((endpoint) => endpoint.deprecated !== undefined)
      .map((endpoint) => endpoint.operationId);

    expect(deprecated).toEqual([]);
  });
});
