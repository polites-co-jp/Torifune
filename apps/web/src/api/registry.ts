import type { z } from 'zod';
import type { PermissionName } from '@/domain/permission';
import type { DeprecationNotice } from './deprecation';

/**
 * エンドポイントの登録。OpenAPI 生成の入力になる。
 *
 * `defineRoute` の副作用として登録される。
 * **登録し忘れたエンドポイントは仕様に出ないが、動作はする。**
 * 「仕様に出ないと困る」のは公開 API だけなので、これで足りる。
 */

export interface EndpointSpec {
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly summary: string;
  readonly permission: PermissionName | null;
  /** 公開 API 仕様に載せるか。 */
  readonly documented: boolean;
  /**
   * セッション認証だけを許すか。
   *
   * OpenAPI の `security` をここから決める。**実態と宣言をずらさない**ため、
   * `defineRoute` が実際に使っている値をそのまま持つ。
   */
  readonly sessionOnly: boolean;
  readonly bodySchema?: z.ZodType | undefined;
  readonly querySchema?: z.ZodType | undefined;
  /**
   * 成功時の応答スキーマ（外側の `{ data }` まで含む）。
   *
   * **任意。** 全エンドポイントへ一度に付けると差分が大きくなりすぎるため、
   * 主要なものから付けている。未宣言の一覧は E2E（`e2e/api-foundation.spec.ts`）で
   * 固定してあり、増やすとテストが落ちて気づける。
   */
  readonly responseSchema?: z.ZodType | undefined;
  /** 成功時のステータス。既定は 200。204 は本文を返さない。 */
  readonly successStatus?: 200 | 201 | 204 | undefined;
  /** 非推奨の告知（05_API設計.md §41）。 */
  readonly deprecated?: DeprecationNotice | undefined;
}

const endpoints = new Map<string, EndpointSpec>();

export function registerEndpoint(spec: EndpointSpec): void {
  // 同じ operationId が二度登録されるのは、モジュールの再評価か命名の衝突。
  // 後勝ちにして、開発中のホットリロードで壊れないようにする。
  endpoints.set(spec.operationId, spec);
}

export function listEndpoints(): readonly EndpointSpec[] {
  return [...endpoints.values()].sort((a, b) => a.operationId.localeCompare(b.operationId));
}

/** 公開 API 仕様に載せるエンドポイント。 */
export function listDocumentedEndpoints(): readonly EndpointSpec[] {
  return listEndpoints().filter((endpoint) => endpoint.documented);
}

export function resetEndpointRegistry(): void {
  endpoints.clear();
}
