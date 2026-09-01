import { defineRoute } from '@/api/route';
import { dataResponse } from '@/api/response';
import { listRoles } from '@/application/authorization/role-use-cases';

export const GET = defineRoute({
  operationId: 'listRoles',
  method: 'GET',
  path: '/roles',
  summary: 'ロール一覧を取得する',
  permission: 'user.manage',
  handler: async ({ context }) => {
    const roles = await listRoles(context, {});
    return dataResponse(roles);
  },
});
