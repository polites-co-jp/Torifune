import { listPermissions } from '@/application/authorization/permission-registry';
import { defineRoute } from '@/api/route';
import { dataResponse } from '@/api/response';

export const GET = defineRoute({
  operationId: 'listPermissions',
  method: 'GET',
  path: '/permissions',
  summary: '登録済み Permission の一覧を取得する',
  permission: 'user.manage',
  handler: async () => dataResponse(listPermissions()),
});
