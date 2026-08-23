import { completeSetup, isSetupOpen } from '@/application/auth/setup';
import { CSRF_COOKIE, readCookie, requestInfoOf } from '@/api/cookies';
import { verifyCsrf } from '@/api/csrf';
import { dataResponse, errorResponse, readJsonBody, stringField } from '@/api/errors';

/**
 * 初回セットアップ。
 *
 * 管理者が1人でもいれば **404**。「セットアップ済みです」とも返さない。
 * 状態を漏らさないため。
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isSetupOpen())) {
    return errorResponse('NOT_FOUND');
  }

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

  const outcome = await completeSetup({
    loginId: stringField(body, 'loginId') ?? '',
    displayName: stringField(body, 'displayName') ?? '',
    email: stringField(body, 'email') ?? '',
    password: stringField(body, 'password') ?? '',
    request: requestInfoOf(request),
  });

  if (!outcome.ok) {
    if (outcome.reason === 'closed') {
      return errorResponse('NOT_FOUND');
    }
    if (outcome.reason === 'conflict') {
      return errorResponse('CONFLICT');
    }
    return errorResponse('VALIDATION_ERROR');
  }

  return dataResponse({ id: outcome.userId }, { status: 201 });
}
