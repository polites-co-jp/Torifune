import { z } from 'zod';
import {
  deleteSocialAccount,
  getSocialAccount,
  updateSocialAccount,
} from '@/application/social/social-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  accountEnvelopeSchema,
  toAccountResponse,
  updateAccountSchema,
} from '@/api/schemas/social';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/** `{id}` のアカウントが無いときの応答（042-social-api-input-fixes 設計 §6.4）。 */
const ACCOUNT_NOT_FOUND = {
  status: 404,
  description: 'アカウントが存在しない（UUID の形でない ID を含む）',
} as const;

export const GET = defineRoute({
  operationId: 'getSocialAccount',
  method: 'GET',
  path: '/social/accounts/{id}',
  summary: 'SNSアカウントを取得する',
  permission: 'social.read',
  response: accountEnvelopeSchema,
  additionalResponses: [ACCOUNT_NOT_FOUND],
  handler: async ({ context, params }) => {
    const account = await getSocialAccount(context, { id: params['id'] ?? '' });
    return dataResponse(toAccountResponse(account));
  },
});

export const PATCH = defineRoute({
  operationId: 'updateSocialAccount',
  method: 'PATCH',
  path: '/social/accounts/{id}',
  summary: 'SNSアカウントを更新する',
  permission: 'social.write',
  body: updateAccountSchema,
  response: accountEnvelopeSchema,
  additionalResponses: [ACCOUNT_NOT_FOUND],
  handler: async ({ context, params, body }) => {
    // `credentials` の突き合わせが publisher の登録簿を引く（設計 §6.7）。
    await ensurePluginsStartedAnonymously();

    const account = await updateSocialAccount(context, {
      id: params['id'] ?? '',
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.handle === undefined ? {} : { handle: body.handle }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.credential === undefined ? {} : { credential: body.credential }),
      ...(body.credentials === undefined ? {} : { credentials: body.credentials }),
    });
    return dataResponse(toAccountResponse(account));
  },
});

export const DELETE = defineRoute({
  operationId: 'deleteSocialAccount',
  method: 'DELETE',
  path: '/social/accounts/{id}',
  summary: 'SNSアカウントを削除する',
  permission: 'social.delete',
  body: z.object({ csrfToken: z.string().optional() }),
  successStatus: 204,
  additionalResponses: [ACCOUNT_NOT_FOUND],
  handler: async ({ context, params }) => {
    await deleteSocialAccount(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
