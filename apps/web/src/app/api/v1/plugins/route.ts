import { installPluginUseCase, listPlugins } from '@/application/plugin/plugin-use-cases';
import { createdResponse, dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { installPluginSchema, toOperationResponse, toPluginResponse } from '@/api/schemas/plugin';
import { scheduleRestart } from '@/plugin/rebuild';

export const GET = defineRoute({
  operationId: 'listPlugins',
  method: 'GET',
  path: '/plugins',
  summary: 'Plugin の一覧を取得する',
  permission: 'plugin.manage',
  handler: async ({ context }) => {
    const result = await listPlugins(context, undefined);

    return dataResponse({
      installed: result.installed.map(toPluginResponse),
      detected: result.detected.map(toPluginResponse),
      problems: result.problems,
      operations: result.operations.map(toOperationResponse),
      canSelfRestart: result.canSelfRestart,
    });
  },
});

export const POST = defineRoute({
  operationId: 'installPlugin',
  method: 'POST',
  path: '/plugins',
  summary: '配置済みの Plugin を導入する',
  // createdResponse（201）を返す。宣言しないと OpenAPI が 200 と書く。
  successStatus: 201,
  permission: 'plugin.manage',
  body: installPluginSchema,
  handler: async ({ context, body }) => {
    const result = await installPluginUseCase(context, { pluginId: body.pluginId });

    // 応答を返し終えてから落とす。
    // 先に落とすと、要求した側は何が起きたか分からない。
    if (result.willRestart) {
      scheduleRestart();
    }

    return createdResponse({
      operationId: result.operationId,
      willRestart: result.willRestart,
      message: result.message,
    });
  },
});
