import { primeAccessLogIpExclusions } from './ip-exclusion';
import { defineUseCase } from '@/application/authorization/use-case';
import { IP_EXCLUSION_MAX_RULES, parseIpExclusionRules } from '@/domain/analytics/ip-exclusion';
import { ValidationError } from '@/domain/repository';
import { accessLogExcludedIpsOf, SYSTEM_SETTING_KEYS } from '@/domain/system-settings';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';

/**
 * アクセスログの除外IPの参照と更新（033-analytics-ip-exclusion 設計 §9）。
 *
 * **参照にも `system.manage` を要求する。** 社内の IP 帯・VPN の出口が書かれており、
 * リストそのものが秘密である（設計 §2）。表示名や基準タイムゾーンのように
 * 「表示は誰でも」にしない。
 */

export interface AccessLogIpExclusions {
  /** 正規表記のルール（`203.0.113.10` / `198.51.100.0/24` / `2001:db8::/32`）。 */
  readonly rules: readonly string[];
}

/** エラーメッセージに並べる不正な行の数。全部並べると読めない。 */
const INVALID_SAMPLE_LIMIT = 3;

export const getAccessLogIpExclusions = defineUseCase<Record<string, never>, AccessLogIpExclusions>(
  {
    name: 'analytics.ipExclusionGet',
    permission: 'system.manage',
    handler: async (context) => {
      const stored = await systemSettingsRepository.loadAll(context.connection);
      // **全項目（`toSystemSettings`）を取らない**（`domain/system-settings.ts` の射影の注記）。
      return { rules: accessLogExcludedIpsOf(stored) };
    },
  },
);

export const updateAccessLogIpExclusions = defineUseCase<
  { readonly rules: readonly string[] },
  AccessLogIpExclusions
>({
  name: 'analytics.ipExclusionUpdate',
  permission: 'system.manage',
  audit: {
    // 既存の `updateSystemSettings` と同じ `action` / `resourceType`。**列挙値を足さない。**
    action: 'updated',
    resourceType: 'system_settings',
    resourceId: () => null,
    // **IP そのものを監査ログに書かない**（設計 §9.2）。
    // このリストは `system.manage` でしか読めない設定であり、
    // 監査ログはそれとは別の経路で読まれ・持ち出されうる。件数だけ残す。
    detail: (_input, output) => ({
      setting: SYSTEM_SETTING_KEYS.accessLogExcludedIps,
      count: output.rules.length,
    }),
  },
  handler: async (context, input) => {
    const parsed = parseIpExclusionRules(input.rules);

    // **1 行でも読めなければ保存しない。** 一部だけ通すと、
    // 「書いたのに効いていない行」が画面から見分けられなくなる。
    if (parsed.invalid.length > 0) {
      const sample = parsed.invalid.slice(0, INVALID_SAMPLE_LIMIT).join('、');
      const rest =
        parsed.invalid.length > INVALID_SAMPLE_LIMIT
          ? `ほか ${parsed.invalid.length - INVALID_SAMPLE_LIMIT} 件`
          : '';
      throw new ValidationError(
        'AccessLogIpExclusions',
        'rules',
        `IPアドレスまたはCIDRとして読めない行があります：${sample}${rest}`,
      );
    }

    if (parsed.rules.length > IP_EXCLUSION_MAX_RULES) {
      throw new ValidationError(
        'AccessLogIpExclusions',
        'rules',
        `除外するIPは ${IP_EXCLUSION_MAX_RULES} 件以内で指定してください。`,
      );
    }

    const rules = parsed.rules.map((rule) => rule.text);

    await context.connection.transaction((tx) =>
      systemSettingsRepository.put(tx, SYSTEM_SETTING_KEYS.accessLogExcludedIps, rules),
    );

    // **保存したプロセスは即座に反映する。** 他プロセスは TTL で追いつく（設計 §6.1）。
    primeAccessLogIpExclusions(rules);

    return { rules };
  },
});
