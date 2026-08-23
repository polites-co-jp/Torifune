import { requestPasswordReset } from '@/application/auth/password-reset';
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

  const email = stringField(body, 'email');
  if (email === undefined || email === '') {
    return errorResponse('VALIDATION_ERROR', { email: ['入力してください。'] });
  }

  await requestPasswordReset({ email, request: requestInfoOf(request) });

  // 登録済みかどうかにかかわらず同じ応答を返す。
  // 存在するアドレスだけ成功を返すと、登録の有無を調べられる。
  return new Response(null, { status: 204 });
}
