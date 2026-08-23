import { confirmPasswordReset } from '@/application/auth/password-reset';
import { CSRF_COOKIE, readCookie, requestInfoOf } from '@/api/cookies';
import { verifyCsrf } from '@/api/csrf';
import { errorResponse, readJsonBody, stringField } from '@/api/errors';

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

  const token = stringField(body, 'token');
  const newPassword = stringField(body, 'newPassword');
  if (token === undefined || token === '' || newPassword === undefined || newPassword === '') {
    return errorResponse('VALIDATION_ERROR');
  }

  const outcome = await confirmPasswordReset({
    token,
    newPassword,
    request: requestInfoOf(request),
  });

  if (!outcome.ok) {
    // 「トークンが無い」と「期限切れ」を区別しない。
    return errorResponse(
      outcome.reason === 'invalid_password' ? 'VALIDATION_ERROR' : 'INVALID_CREDENTIALS',
    );
  }

  return new Response(null, { status: 204 });
}
