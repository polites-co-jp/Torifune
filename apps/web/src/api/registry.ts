import type { z } from 'zod';
import type { PermissionName } from '@/domain/permission';

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
  readonly bodySchema?: z.ZodType | undefined;
  readonly querySchema?: z.ZodType | undefined;
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
