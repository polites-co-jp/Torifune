import { z } from 'zod';
import { requestPasswordReset } from '@/application/auth/password-reset';
import { requestInfoOf } from '@/api/cookies';
import { noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

export const POST = defineRoute({
  operationId: 'requestPasswordReset',
  method: 'POST',
  path: '/auth/password-reset/request',
  summary: 'パスワード再設定を要求する',
  permission: null,
  reason: '認証前に呼ばれる。登録の有無にかかわらず同じ応答を返すため、情報を漏らさない',
  body: z.object({
    email: z.string().min(1, '入力してください。'),
    csrfToken: z.string().optional(),
  }),
  successStatus: 204,
  rateLimit: { windowMs: 60_000, max: 10 },
  handler: async ({ request, body }) => {
    await requestPasswordReset({ email: body.email, request: requestInfoOf(request) });

    // 登録済みかどうかにかかわらず同じ応答を返す。
    return noContentResponse();
  },
});
