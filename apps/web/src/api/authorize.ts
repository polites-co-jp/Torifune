import { ForbiddenError, UnauthenticatedError } from '@/application/authorization/authorize';
import { UnknownPermissionError } from '@/application/authorization/permission-registry';
import { errorResponse } from './errors';

/**
 * 認可エラーを HTTP へ写す。
 *
 * **API Layer の責務はこれだけ。** 判定そのものは Application 層にある。
 */
export function authorizationErrorResponse(error: unknown): Response | null {
  if (error instanceof UnauthenticatedError) {
    return errorResponse('UNAUTHENTICATED');
  }
  if (error instanceof ForbiddenError) {
    // 要求された Permission 名を応答へ入れない（権限体系の探索に使われる）。
    return errorResponse('FORBIDDEN');
  }
  if (error instanceof UnknownPermissionError) {
    // 実装の誤り。相手には内部事情を伝えない。
    return errorResponse('INTERNAL_ERROR');
  }
  return null;
}

/** ルートハンドラを認可エラーの変換で包む。 */
export async function withAuthorization(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const response = authorizationErrorResponse(error);
    if (response !== null) {
      return response;
    }
    throw error;
  }
}
