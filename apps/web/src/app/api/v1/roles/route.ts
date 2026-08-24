import { defineRoute } from '@/api/route';
import { dataResponse } from '@/api/response';
import { roleRepository } from '@/infrastructure/role-repository';

export const GET = defineRoute({
  operationId: 'listRoles',
  method: 'GET',
  path: '/roles',
  summary: 'ロール一覧を取得する',
  permission: 'user.manage',
  handler: async ({ context }) => {
    const roles = await roleRepository.list(context.connection);
    return dataResponse(roles);
  },
});
