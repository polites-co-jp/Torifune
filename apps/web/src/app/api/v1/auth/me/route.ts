import { buildAuthorizationContext } from '@/application/authorization/context';
import { toPublicUser } from '@/authentication/identity';
import { readCookie, requestInfoOf, SESSION_COOKIE } from '@/api/cookies';
import { dataResponse, errorResponse } from '@/api/errors';

export async function GET(request: Request): Promise<Response> {
  const context = await buildAuthorizationContext(
    readCookie(request, SESSION_COOKIE),
    requestInfoOf(request),
  );

  if (context.identity === null) {
    return errorResponse('UNAUTHENTICATED');
  }

  // permissions は **UI の表示制御のため**に返す。
  // 認可はサーバー側で行っており、この配列を書き換えても判定は変わらない
  // （06_画面設計.md §29）。
  return dataResponse({
    ...toPublicUser(context.identity),
    permissions: [...context.permissions].sort(),
  });
}
