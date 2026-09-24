import { requestInfoOf } from '@/api/cookies';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { toUserResponse, updateUserSchema, userEnvelopeSchema } from '@/api/schemas/user';
import { deleteUser, getUser, updateUser } from '@/application/user/user-use-cases';

/** `{id}` のユーザーが無いときの応答（043-api-input-fixes-rest 設計 §6.4）。 */
const USER_NOT_FOUND = {
  status: 404,
  description: 'ユーザーが存在しない（UUID の形でない ID を含む）',
} as const;

export const GET = defineRoute({
  operationId: 'getUser',
  method: 'GET',
  path: '/users/{id}',
  summary: 'ユーザーを取得する',
  permission: 'user.manage',
  response: userEnvelopeSchema,
  additionalResponses: [USER_NOT_FOUND],
  handler: async ({ context, params }) => {
    return dataResponse(toUserResponse(await getUser(context, { id: params['id'] ?? '' })));
  },
});

export const PATCH = defineRoute({
  operationId: 'updateUser',
  method: 'PATCH',
  path: '/users/{id}',
  summary: 'ユーザーを更新する',
  permission: 'user.manage',
  body: updateUserSchema,
  response: userEnvelopeSchema,
  additionalResponses: [
    USER_NOT_FOUND,
    {
      status: 409,
      description: 'メールアドレスが既に使われている',
    },
  ],
  handler: async ({ context, body, params, request }) => {
    const updated = await updateUser(context, {
      id: params['id'] ?? '',
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.password === undefined ? {} : { password: body.password }),
      ...(body.roles === undefined ? {} : { roles: body.roles }),
      request: requestInfoOf(request),
    });

    return dataResponse(toUserResponse(updated));
  },
});

export const DELETE = defineRoute({
  operationId: 'deleteUser',
  method: 'DELETE',
  path: '/users/{id}',
  summary: 'ユーザーを削除する',
  permission: 'user.manage',
  successStatus: 204,
  additionalResponses: [USER_NOT_FOUND],
  handler: async ({ context, params }) => {
    await deleteUser(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
