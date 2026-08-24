import { csrfCookie } from '@/api/cookies';
import { generateCsrfToken } from '@/api/csrf';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * CSRF トークンを発行する。
 *
 * 画面はまずここを叩き、返ってきたトークンを以後の POST に付ける。
 * Cookie と本文の両方に同じ値を入れる（二重送信）。
 */
export const GET = defineRoute({
  operationId: 'issueCsrfToken',
  method: 'GET',
  path: '/auth/csrf',
  summary: 'CSRF トークンを発行する',
  permission: null,
  reason: '認証前に必要になる。トークン自体は秘密ではなく、Cookie との一致だけが意味を持つ',
  handler: async ({ request }) => {
    const token = generateCsrfToken();
    return dataResponse(
      { csrfToken: token },
      { headers: { 'Set-Cookie': csrfCookie(request, token) } },
    );
  },
});
