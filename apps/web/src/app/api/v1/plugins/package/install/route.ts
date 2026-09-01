import { installPluginPackage } from '@/application/plugin/plugin-use-cases';
import { errorResponse } from '@/api/errors';
import { createdResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { readUploadedPackage } from '@/api/upload';
import { scheduleRestart } from '@/plugin/rebuild';

/**
 * 同意したあとに Plugin Package を展開して導入する。
 *
 * **同意した Plugin と中身が一致することを UseCase 側で確かめる。**
 * 確かめないと、同意の直後に別の Plugin へ差し替えられる。
 */
export const POST = defineRoute({
  operationId: 'installPluginPackage',
  method: 'POST',
  path: '/plugins/package/install',
  summary: 'Plugin Package を展開して導入する',
  // createdResponse（201）を返す。宣言しないと OpenAPI が 200 と書く。
  successStatus: 201,
  permission: 'plugin.manage',
  bodyKind: 'raw',
  handler: async ({ context, request }) => {
    const uploaded = await readUploadedPackage(request);
    if (uploaded instanceof Response) {
      return uploaded;
    }

    if (uploaded.pluginId === null) {
      return errorResponse('VALIDATION_ERROR', {
        pluginId: ['導入する Plugin を指定してください。'],
      });
    }

    const result = await installPluginPackage(context, {
      archive: uploaded.archive,
      expectedPluginId: uploaded.pluginId,
    });

    // 応答を返し終えてから落とす。
    if (result.willRestart) {
      scheduleRestart();
    }

    return createdResponse(result);
  },
});
