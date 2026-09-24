import { enablePluginUseCase } from '@/application/plugin/plugin-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { togglePluginSchema } from '@/api/schemas/plugin';

export const POST = defineRoute({
  operationId: 'enablePlugin',
  method: 'POST',
  path: '/plugins/{id}/enable',
  summary: 'Plugin を有効化する',
  permission: 'plugin.manage',
  body: togglePluginSchema,
  additionalResponses: [
    {
      status: 404,
      description: 'Plugin が配置されていない、または導入されていない',
    },
  ],
  handler: async ({ context, params }) => {
    // 有効化では再ビルドしない。レジストリはすでにビルドに含まれている。
    const result = await enablePluginUseCase(context, { pluginId: params['id'] ?? '' });
    return dataResponse(result);
  },
});
