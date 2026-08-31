import { requestInfoOf } from '@/api/cookies';
import { parseSort } from '@/api/query';
import { createdResponse, pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  createUserSchema,
  toUserResponse,
  USER_SORT_FIELDS,
  userListQuerySchema,
} from '@/api/schemas/user';
import { createUser, listUsers } from '@/application/user/user-use-cases';

const DEFAULT_SORT = [{ field: 'created_at', direction: 'desc' as const }];

export const GET = defineRoute({
  operationId: 'listUsers',
  method: 'GET',
  path: '/users',
  summary: 'ユーザーの一覧を取得する',
  permission: 'user.manage',
  query: userListQuerySchema,
  handler: async ({ context, query }) => {
    const sort = parseSort(query.sort, USER_SORT_FIELDS, DEFAULT_SORT);

    const page = await listUsers(context, {
      page: query.page,
      perPage: query.perPage,
      status: query.status ?? null,
      keyword: query.q ?? null,
      sort,
    });

    return pageResponse(page.items.map(toUserResponse), {
      page: query.page,
      perPage: query.perPage,
      total: page.total,
    });
  },
});

export const POST = defineRoute({
  operationId: 'createUser',
  method: 'POST',
  path: '/users',
  summary: 'ユーザーを作成する',
  permission: 'user.manage',
  body: createUserSchema,
  handler: async ({ context, body, request }) => {
    const created = await createUser(context, {
      loginId: body.loginId,
      displayName: body.displayName,
      email: body.email,
      password: body.password,
      roles: body.roles,
      request: requestInfoOf(request),
    });

    return createdResponse(toUserResponse(created));
  },
});
