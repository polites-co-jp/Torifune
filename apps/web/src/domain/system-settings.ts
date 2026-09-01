/**
 * システム設定（06_画面設計.md §16）。
 *
 * 設計は docs/設計/015b-settings/設計.md §3.1-3.3。
 *
 * **画面から変えられるものだけをここに置く。**
 * セッションの有効期限やアイドルタイムアウトは置かない。
 * 短くしすぎて自分を締め出す、長くしすぎて放置端末が生きる、といった
 * 事故が起きる。必要になったら要求と合わせて設計する。
 */

export const SERVICE_NAME_MAX_LENGTH = 50;

/** 既定のサービス表示名。 */
export const DEFAULT_SERVICE_NAME = 'とりふね';

/** 長期セッションの期間。既定（7日）より十分に長く、無制限にはしない。 */
export const REMEMBER_ME_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface SystemSettings {
  /** 画面のヘッダとタイトルに出る名前。環境を見分けるために変える。 */
  readonly serviceName: string;
  /**
   * Remember Me（長期ログイン）を許すか。
   *
   * 組織の方針で禁止したい場合があるため、切り替えられるようにする。
   */
  readonly rememberMeEnabled: boolean;
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  serviceName: DEFAULT_SERVICE_NAME,
  rememberMeEnabled: true,
};

/** 保存に使うキー。**値の形を変えるときはキーも変える。** */
export const SYSTEM_SETTING_KEYS = {
  serviceName: 'general.service_name',
  rememberMeEnabled: 'auth.remember_me_enabled',
} as const;

export function isValidServiceName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= SERVICE_NAME_MAX_LENGTH;
}

/**
 * 保存されている値から設定を組み立てる。
 *
 * **壊れた値は既定へ落とす。** 設定の読み出しでアプリが起動しなくなるより、
 * 既定で動いたほうがよい。表示名が既定に戻れば、人が気づいて直せる。
 */
export function toSystemSettings(stored: ReadonlyMap<string, unknown>): SystemSettings {
  const serviceName = stored.get(SYSTEM_SETTING_KEYS.serviceName);
  const rememberMe = stored.get(SYSTEM_SETTING_KEYS.rememberMeEnabled);

  return {
    serviceName:
      typeof serviceName === 'string' && isValidServiceName(serviceName)
        ? serviceName.trim()
        : DEFAULT_SYSTEM_SETTINGS.serviceName,
    rememberMeEnabled:
      typeof rememberMe === 'boolean' ? rememberMe : DEFAULT_SYSTEM_SETTINGS.rememberMeEnabled,
  };
}

/** セッションの有効期限を求める。長期ログインが許されていなければ既定のまま。 */
export function sessionLifetimeMs(
  defaultLifetimeMs: number,
  options: { readonly rememberMe: boolean; readonly rememberMeEnabled: boolean },
): number {
  return options.rememberMe && options.rememberMeEnabled
    ? REMEMBER_ME_LIFETIME_MS
    : defaultLifetimeMs;
}
