import { inspectPluginPackage } from '@/application/plugin/plugin-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { readUploadedPackage } from '@/api/upload';

/**
 * Plugin Package を受け取って**検証だけ**する。
 *
 * **導入はしない。** 要求 Permission を見せてから同意させるため、
 * 展開して Manifest を読む段階と、導入を確定する段階を分ける
 * （06_画面設計.md §39）。
 */
export const POST = defineRoute({
  operationId: 'inspectPluginPackage',
  method: 'POST',
  path: '/plugins/package/inspect',
  summary: 'Plugin Package を検証して要求 Permission を返す',
  permission: 'plugin.manage',
  // ファイルを受け取るため、ボディはハンドラが自分で読む。
  // CSRF トークンは x-csrf-token ヘッダで送る。
  bodyKind: 'raw',
  handler: async ({ context, request }) => {
    const uploaded = await readUploadedPackage(request);
    if (uploaded instanceof Response) {
      return uploaded;
    }

    const result = await inspectPluginPackage(context, { archive: uploaded.archive });
    return dataResponse(result);
  },
});
