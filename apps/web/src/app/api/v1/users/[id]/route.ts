import { requestInfoOf } from '@/api/cookies';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { toUserResponse, updateUserSchema, userEnvelopeSchema } from '@/api/schemas/user';
import { deleteUser, getUser, updateUser } from '@/application/user/user-use-cases';

export const GET = defineRoute({
  operationId: 'getUser',
  method: 'GET',
  path: '/users/{id}',
  summary: 'ユーザーを取得する',
  permission: 'user.manage',
  response: userEnvelopeSchema,
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
  handler: async ({ context, params }) => {
    await deleteUser(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
