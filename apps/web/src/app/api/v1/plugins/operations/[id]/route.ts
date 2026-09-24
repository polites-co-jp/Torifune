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
  additionalResponses: [
    {
      status: 404,
      description: 'Plugin の操作が存在しない（UUID の形でない ID を含む）',
    },
  ],
  handler: async ({ context, params }) => {
    const operation = await getPluginOperation(context, { id: params['id'] ?? '' });
    return dataResponse(toOperationResponse(operation));
  },
});
