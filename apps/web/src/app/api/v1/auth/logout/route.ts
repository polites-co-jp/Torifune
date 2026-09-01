import { z } from 'zod';
import { logout } from '@/application/auth/logout';
import { clearedSessionCookie, readCookie, requestInfoOf, SESSION_COOKIE } from '@/api/cookies';
import { noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

export const POST = defineRoute({
  operationId: 'logout',
  method: 'POST',
  path: '/auth/logout',
  summary: 'ログアウトする',
  permission: null,
  reason: 'セッションを失効させるだけ。冪等で、他人に害が無い',
  body: z.object({ csrfToken: z.string().optional() }),
  successStatus: 204,
  handler: async ({ request }) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token !== undefined && token !== '') {
      await logout(token, requestInfoOf(request));
    }

    // セッションが無くてもエラーにしない。ログアウトは冪等でよい。
    return noContentResponse({ headers: { 'Set-Cookie': clearedSessionCookie(request) } });
  },
});
