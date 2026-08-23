import { getCurrentUser } from '@/application/auth/current-user';
import { toPublicUser } from '@/authentication/identity';
import { readCookie, requestInfoOf, SESSION_COOKIE } from '@/api/cookies';
import { dataResponse, errorResponse } from '@/api/errors';

export async function GET(request: Request): Promise<Response> {
  const identity = await getCurrentUser(
    readCookie(request, SESSION_COOKIE),
    requestInfoOf(request),
  );

  if (identity === null) {
    return errorResponse('UNAUTHENTICATED');
  }

  // passwordHash 等の内部情報を出さないよう、明示的に選んだ項目だけを返す。
  return dataResponse(toPublicUser(identity));
}
