import { logout } from '@/application/auth/logout';
import {
  clearedSessionCookie,
  CSRF_COOKIE,
  readCookie,
  requestInfoOf,
  SESSION_COOKIE,
} from '@/api/cookies';
import { verifyCsrf } from '@/api/csrf';
import { errorResponse, readJsonBody, stringField } from '@/api/errors';

export async function POST(request: Request): Promise<Response> {
  const body = (await readJsonBody(request)) ?? {};

  if (
    !verifyCsrf(request, {
      cookieToken: readCookie(request, CSRF_COOKIE),
      bodyToken: stringField(body, 'csrfToken'),
    })
  ) {
    return errorResponse('CSRF_FAILED');
  }

  const token = readCookie(request, SESSION_COOKIE);
  if (token !== undefined && token !== '') {
    await logout(token, requestInfoOf(request));
  }

  // セッションが無くてもエラーにしない。ログアウトは冪等でよい。
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': clearedSessionCookie(request) },
  });
}
