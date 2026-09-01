import { z } from 'zod';
import { confirmPasswordReset } from '@/application/auth/password-reset';
import { requestInfoOf } from '@/api/cookies';
import { errorResponse } from '@/api/errors';
import { noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

export const POST = defineRoute({
  operationId: 'confirmPasswordReset',
  method: 'POST',
  path: '/auth/password-reset/confirm',
  summary: 'パスワードを再設定する',
  permission: null,
  reason: '認証前に呼ばれる。トークンの所持が本人性の根拠になる',
  body: z.object({
    token: z.string().min(1, '入力してください。'),
    newPassword: z.string().min(1, '入力してください。'),
    csrfToken: z.string().optional(),
  }),
  successStatus: 204,
  rateLimit: { windowMs: 60_000, max: 20 },
  handler: async ({ request, body }) => {
    const outcome = await confirmPasswordReset({
      token: body.token,
      newPassword: body.newPassword,
      request: requestInfoOf(request),
    });

    if (!outcome.ok) {
      // 「トークンが無い」と「期限切れ」を区別しない。
      return errorResponse(
        outcome.reason === 'invalid_password' ? 'VALIDATION_ERROR' : 'INVALID_CREDENTIALS',
      );
    }

    return noContentResponse();
  },
});
