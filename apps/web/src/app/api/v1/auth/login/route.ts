import { login } from '@/application/auth/login';
import { CSRF_COOKIE, readCookie, requestInfoOf, sessionCookie } from '@/api/cookies';
import { verifyCsrf } from '@/api/csrf';
import { dataResponse, errorResponse, readJsonBody, stringField } from '@/api/errors';

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('VALIDATION_ERROR');
  }

  if (
    !verifyCsrf(request, {
      cookieToken: readCookie(request, CSRF_COOKIE),
      bodyToken: stringField(body, 'csrfToken'),
    })
  ) {
    return errorResponse('CSRF_FAILED');
  }

  const loginId = stringField(body, 'loginId');
  const password = stringField(body, 'password');
  if (loginId === undefined || loginId === '' || password === undefined || password === '') {
    return errorResponse('VALIDATION_ERROR', {
      ...(loginId === undefined || loginId === '' ? { loginId: ['入力してください。'] } : {}),
      ...(password === undefined || password === '' ? { password: ['入力してください。'] } : {}),
    });
  }

  const outcome = await login({ loginId, password, request: requestInfoOf(request) });

  if (!outcome.ok) {
    // 「IDが無い」と「パスワードが違う」を区別しない。
    // 区別できると、アカウントを列挙できてしまう。
    return errorResponse(
      outcome.reason === 'too_many_attempts' ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CREDENTIALS',
    );
  }

  return dataResponse(outcome.user, {
    headers: { 'Set-Cookie': sessionCookie(request, outcome.sessionToken, outcome.expiresAt) },
  });
}
