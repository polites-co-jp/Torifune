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

/**
 * **応答は UseCase が公開してよい項目へ射影している**（032-timezone-setting 設計 §6.5.1）。
 *
 * この口は `permission: null` で、**Cookie 無しでも叩ける**。
 * かつては Domain の全項目（`SystemSettings`）がそのまま出ており、
 * 基準タイムゾーンを足したときに「インスタンスの運用地域が未認証の 1 リクエストで分かる」
 * 状態になった。
 *
 * **ルートで応答を組み立て直さない。** 判断の置き場が Domain の射影型
 * （`PublicSystemSettings`）とルートの 2 か所にあると、片方だけ直る。
 * 何を公開するかは `getSystemSettings` の戻り値の型が決めており、
 * ここはそれをそのまま返してよい。
 *
 * 基準タイムゾーンを読む口は `/api/v1/settings/timezone`（`system.manage`）。
 * 設定画面は値と**出所**の両方が要るので、そもそもこの API を使っていない。
 */
export const GET = defineRoute({
  operationId: 'getSystemSettings',
  method: 'GET',
  path: '/settings',
  summary: 'システム設定を取得する',
  permission: null,
  reason: '戻り値が公開してよい項目へ射影されている。表示名と長期ログインの可否だけ',
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
