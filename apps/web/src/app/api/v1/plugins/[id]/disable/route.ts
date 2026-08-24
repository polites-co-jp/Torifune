import { disablePluginUseCase } from '@/application/plugin/plugin-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { togglePluginSchema } from '@/api/schemas/plugin';

export const POST = defineRoute({
  operationId: 'disablePlugin',
  method: 'POST',
  path: '/plugins/{id}/disable',
  summary: 'Plugin を無効化する',
  permission: 'plugin.manage',
  body: togglePluginSchema,
  handler: async ({ context, params }) => {
    // 依存元も一緒に無効化される。何が止まったかを返す。
    const result = await disablePluginUseCase(context, { pluginId: params['id'] ?? '' });
    return dataResponse(result);
  },
});
