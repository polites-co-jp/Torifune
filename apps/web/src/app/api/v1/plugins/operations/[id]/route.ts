import { getPluginOperation } from '@/application/plugin/plugin-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { toOperationResponse } from '@/api/schemas/plugin';

export const GET = defineRoute({
  operationId: 'getPluginOperation',
  method: 'GET',
  path: '/plugins/operations/{id}',
  summary: 'Plugin 操作の状況を取得する',
  permission: 'plugin.manage',
  handler: async ({ context, params }) => {
    const operation = await getPluginOperation(context, { id: params['id'] ?? '' });
    return dataResponse(toOperationResponse(operation));
  },
});
