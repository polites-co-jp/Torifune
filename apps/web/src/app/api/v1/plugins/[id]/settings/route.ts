import { z } from 'zod';
import {
  getPluginSettings,
  savePluginSettings,
} from '@/application/plugin/plugin-settings-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

const saveSettingsSchema = z.object({
  /** 宣言された項目だけが通る。検証は UseCase 側。 */
  values: z.record(z.string(), z.string()),
  csrfToken: z.string().optional(),
});

export const GET = defineRoute({
  operationId: 'getPluginSettings',
  method: 'GET',
  path: '/plugins/{id}/settings',
  summary: 'Plugin の設定項目と現在値を取得する',
  permission: 'plugin.manage',
  handler: async ({ context, params }) => {
    // Secret の平文は返らない（06_画面設計.md §38）。
    const settings = await getPluginSettings(context, { pluginId: params['id'] ?? '' });
    return dataResponse(settings);
  },
});

export const PUT = defineRoute({
  operationId: 'savePluginSettings',
  method: 'PUT',
  path: '/plugins/{id}/settings',
  summary: 'Plugin の設定を保存する',
  permission: 'plugin.manage',
  body: saveSettingsSchema,
  handler: async ({ context, params, body }) => {
    const result = await savePluginSettings(context, {
      pluginId: params['id'] ?? '',
      values: body.values,
    });
    return dataResponse(result);
  },
});
