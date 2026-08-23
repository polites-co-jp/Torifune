import { csrfCookie } from '@/api/cookies';
import { generateCsrfToken } from '@/api/csrf';
import { dataResponse } from '@/api/errors';

/**
 * CSRF トークンを発行する。
 *
 * 画面はまずここを叩き、返ってきたトークンを以後の POST に付ける。
 * Cookie と本文の両方に同じ値を入れる（二重送信）。
 */
export function GET(request: Request): Response {
  const token = generateCsrfToken();
  return dataResponse(
    { csrfToken: token },
    { headers: { 'Set-Cookie': csrfCookie(request, token) } },
  );
}
