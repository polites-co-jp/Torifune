import { z } from 'zod';
import { login } from '@/application/auth/login';
import { requestInfoOf, sessionCookie } from '@/api/cookies';
import { errorResponse } from '@/api/errors';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

const LoginBody = z.object({
  loginId: z.string().min(1, '入力してください。'),
  password: z.string().min(1, '入力してください。'),
  csrfToken: z.string().optional(),
});

export const POST = defineRoute({
  operationId: 'login',
  method: 'POST',
  path: '/auth/login',
  summary: 'ログインする',
  permission: null,
  reason: 'ログイン処理そのもの。認証前に呼ばれる',
  body: LoginBody,
  // 総当たり対策は authentication/rate-limit.ts が担うが、
  // そこへ到達する前の物量も止める（05_API設計.md §36）。
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ request, body }) => {
    const outcome = await login({
      loginId: body.loginId,
      password: body.password,
      request: requestInfoOf(request),
    });

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
  },
});
