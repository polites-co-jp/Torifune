import { defineUseCase } from '@/application/authorization/use-case';
import { withConnection } from '@/application/transaction';
import { ValidationError } from '@/domain/repository';
import {
  isValidServiceName,
  SERVICE_NAME_MAX_LENGTH,
  SYSTEM_SETTING_KEYS,
  toPublicSystemSettings,
  type PublicSystemSettings,
} from '@/domain/system-settings';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';

/**
 * システム設定（06_画面設計.md §16）。
 *
 * **`system.manage` の消費先。** これまで Permission だけがあって、
 * 要求する処理が存在しなかった（`001/03_リスクと未決事項.md` S-7）。
 */

/**
 * 認証や画面表示のために、認可の文脈を持たずに読む。
 *
 * **UseCase にしない。** ログイン処理やレイアウトの描画は認証前・認可前に
 * 動くため、`AuthorizationContext` を取れない。
 *
 * **戻り値は `PublicSystemSettings` に射影する**（032-timezone-setting 設計 §6.5.1）。
 * 全項目を返すと、認可の文脈を持たないこの口から基準タイムゾーン
 * （インスタンスの運用地域）まで読めてしまう。
 */
export async function loadSystemSettings(): Promise<PublicSystemSettings> {
  const stored = await withConnection((connection) => systemSettingsRepository.loadAll(connection));
  return toPublicSystemSettings(stored);
}

/**
 * 表示名と長期ログインの可否を読む。
 *
 * **`permission: null`。** 表示名は画面のあちこちで要り、ログイン画面（認証前）でも使う。
 *
 * **戻り値を `PublicSystemSettings` へ射影してあることが、認可を要らなくしている根拠である。**
 * この口は `GET /api/v1/settings` として **Cookie 無しでも叩ける**。
 * 全項目を返していたときは、基準タイムゾーンが未認証の 1 リクエストで読めた。
 * 射影を Domain の型として持つので、**ルート側で応答を組み立て直す必要は無い**
 * ——判断の置き場を 2 か所にすると、片方だけ直る（設計 §6.5.1）。
 */
export const getSystemSettings = defineUseCase<Record<string, never>, PublicSystemSettings>({
  name: 'systemSettings.get',
  permission: null,
  reason: '戻り値を公開してよい項目へ射影している。表示名と長期ログインの可否だけを返す',
  handler: async (context) => {
    const stored = await systemSettingsRepository.loadAll(context.connection);
    return toPublicSystemSettings(stored);
  },
});

export interface UpdateSystemSettingsInput {
  readonly serviceName?: string | undefined;
  readonly rememberMeEnabled?: boolean | undefined;
}

export const updateSystemSettings = defineUseCase<UpdateSystemSettingsInput, PublicSystemSettings>({
  name: 'systemSettings.update',
  permission: 'system.manage',
  audit: {
    action: 'updated',
    resourceType: 'system_settings',
    resourceId: () => null,
    detail: (input) => ({ changed: Object.keys(input) }),
  },
  handler: async (context, input) => {
    if (input.serviceName !== undefined && !isValidServiceName(input.serviceName)) {
      throw new ValidationError(
        'SystemSettings',
        'serviceName',
        `表示名を入力してください（${SERVICE_NAME_MAX_LENGTH}文字以内）。`,
      );
    }

    await context.connection.transaction(async (tx) => {
      if (input.serviceName !== undefined) {
        await systemSettingsRepository.put(
          tx,
          SYSTEM_SETTING_KEYS.serviceName,
          input.serviceName.trim(),
        );
      }
      if (input.rememberMeEnabled !== undefined) {
        await systemSettingsRepository.put(
          tx,
          SYSTEM_SETTING_KEYS.rememberMeEnabled,
          input.rememberMeEnabled,
        );
      }
    });

    // 応答は読み出しと同じ形にそろえる（この口は `system.manage` だが、
    // 画面が使うのは表示名と長期ログインの可否の 2 つだけ）。
    return toPublicSystemSettings(await systemSettingsRepository.loadAll(context.connection));
  },
});
