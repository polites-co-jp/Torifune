import { uninstallPluginUseCase } from '@/application/plugin/plugin-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { uninstallPluginSchema } from '@/api/schemas/plugin';
import { scheduleRestart } from '@/plugin/rebuild';

export const DELETE = defineRoute({
  operationId: 'uninstallPlugin',
  method: 'DELETE',
  path: '/plugins/{id}',
  summary: 'Plugin を削除する',
  permission: 'plugin.manage',
  body: uninstallPluginSchema,
  handler: async ({ context, params, body }) => {
    const result = await uninstallPluginUseCase(context, {
      pluginId: params['id'] ?? '',
      deleteData: body.deleteData,
      deleteFiles: body.deleteFiles,
      confirm: body.confirm,
    });

    if (result.willRestart) {
      scheduleRestart();
    }

    return dataResponse(result);
  },
});
