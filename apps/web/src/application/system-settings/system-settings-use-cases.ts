import { defineUseCase } from '@/application/authorization/use-case';
import { withConnection } from '@/application/transaction';
import { ValidationError } from '@/domain/repository';
import {
  isValidServiceName,
  SERVICE_NAME_MAX_LENGTH,
  SYSTEM_SETTING_KEYS,
  toSystemSettings,
  type SystemSettings,
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
 * 表示名と「長期ログインを許すか」は秘密ではないので、これで問題ない。
 */
export async function loadSystemSettings(): Promise<SystemSettings> {
  const stored = await withConnection((connection) => systemSettingsRepository.loadAll(connection));
  return toSystemSettings(stored);
}

export const getSystemSettings = defineUseCase<Record<string, never>, SystemSettings>({
  name: 'systemSettings.get',
  // 表示名は画面のあちこちで要る。読むだけなら誰でもよい。
  permission: null,
  reason: 'サービス表示名は認証後の全画面で使う。秘密の値を含まない',
  handler: async (context) => {
    const stored = await systemSettingsRepository.loadAll(context.connection);
    return toSystemSettings(stored);
  },
});

export interface UpdateSystemSettingsInput {
  readonly serviceName?: string | undefined;
  readonly rememberMeEnabled?: boolean | undefined;
}

export const updateSystemSettings = defineUseCase<UpdateSystemSettingsInput, SystemSettings>({
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

    return toSystemSettings(await systemSettingsRepository.loadAll(context.connection));
  },
});
