import { z } from 'zod';
import {
  getSystemSettings,
  updateSystemSettings,
} from '@/application/system-settings/system-settings-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { SERVICE_NAME_MAX_LENGTH } from '@/domain/system-settings';

/**
 * システム設定（06_画面設計.md §16 の「一般」「認証」タブ）。
 *
 * **`system.manage` の消費先。**
 */

export const GET = defineRoute({
  operationId: 'getSystemSettings',
  method: 'GET',
  path: '/settings',
  summary: 'システム設定を取得する',
  permission: null,
  reason: 'サービス表示名は認証後の全画面で使う。秘密の値を含まない',
  handler: async ({ context }) => dataResponse(await getSystemSettings(context, {})),
});

export const PUT = defineRoute({
  operationId: 'updateSystemSettings',
  method: 'PUT',
  path: '/settings',
  summary: 'システム設定を更新する',
  permission: 'system.manage',
  body: z.object({
    serviceName: z
      .string()
      .min(1, '入力してください。')
      .max(SERVICE_NAME_MAX_LENGTH, `${SERVICE_NAME_MAX_LENGTH}文字以内で入力してください。`)
      .optional(),
    rememberMeEnabled: z.boolean().optional(),
    csrfToken: z.string().optional(),
  }),
  handler: async ({ context, body }) =>
    dataResponse(
      await updateSystemSettings(context, {
        serviceName: body.serviceName,
        rememberMeEnabled: body.rememberMeEnabled,
      }),
    ),
});
