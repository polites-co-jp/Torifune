import { z } from 'zod';
import { completeSetup, isSetupOpen } from '@/application/auth/setup';
import { requestInfoOf } from '@/api/cookies';
import { errorResponse } from '@/api/errors';
import { createdResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * 初回セットアップ。
 *
 * 管理者が1人でもいれば **404**。「セットアップ済みです」とも返さない。
 * 状態を漏らさないため。
 */
export const POST = defineRoute({
  operationId: 'completeSetup',
  method: 'POST',
  path: '/setup',
  summary: '最初の管理者を作成する',
  permission: null,
  reason: '管理者が0人のときだけ開く。認可する相手がまだ存在しない',
  body: z.object({
    loginId: z.string().default(''),
    displayName: z.string().default(''),
    email: z.string().default(''),
    password: z.string().default(''),
    csrfToken: z.string().optional(),
  }),
  handler: async ({ request, body }) => {
    if (!(await isSetupOpen())) {
      return errorResponse('NOT_FOUND');
    }

    const outcome = await completeSetup({
      loginId: body.loginId,
      displayName: body.displayName,
      email: body.email,
      password: body.password,
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

    return createdResponse({ id: outcome.userId });
  },
});
