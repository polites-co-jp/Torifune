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

import { isValidTimeZone } from './analytics/day';

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
  /**
   * 集計の「1日の境目」を決める基準タイムゾーン（032-timezone-setting 設計 §5.2）。
   *
   * **`null` は「未設定」**で、環境変数 `TORIFUNE_TIMEZONE`（さらに無ければ `UTC`）へ
   * 落ちることを表す。既定を `'UTC'` にすると、`TORIFUNE_TIMEZONE=Asia/Tokyo` の既存環境が、
   * 画面で一度も触っていないのに UTC へ落ちる。
   */
  readonly analyticsTimeZone: string | null;
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  serviceName: DEFAULT_SERVICE_NAME,
  rememberMeEnabled: true,
  analyticsTimeZone: null,
};

/** 保存に使うキー。**値の形を変えるときはキーも変える。** */
export const SYSTEM_SETTING_KEYS = {
  serviceName: 'general.service_name',
  rememberMeEnabled: 'auth.remember_me_enabled',
  analyticsTimeZone: 'analytics.time_zone',
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
  const timeZone = stored.get(SYSTEM_SETTING_KEYS.analyticsTimeZone);

  return {
    serviceName:
      typeof serviceName === 'string' && isValidServiceName(serviceName)
        ? serviceName.trim()
        : DEFAULT_SYSTEM_SETTINGS.serviceName,
    rememberMeEnabled:
      typeof rememberMe === 'boolean' ? rememberMe : DEFAULT_SYSTEM_SETTINGS.rememberMeEnabled,
    // **読み出しでは一覧（`isSelectableTimeZone`）と照合しない**（設計 §5.2）。
    // 一覧に無いだけの値（`Etc/GMT+5`）を落とすと、保存済みの環境の境目が黙って動く。
    analyticsTimeZone:
      typeof timeZone === 'string' && isValidTimeZone(timeZone)
        ? timeZone
        : DEFAULT_SYSTEM_SETTINGS.analyticsTimeZone,
  };
}

/**
 * **未認証で読んでよい項目だけ**（032-timezone-setting 設計 §6.5.1）。
 *
 * **ここへ項目を足すことが「未認証へ公開する」という判断そのものになる。**
 * 判断を 1 か所に閉じ込めるための型であって、単なる部分集合ではない。
 *
 * 基準タイムゾーン（`analyticsTimeZone`）を足したとき、
 * `getSystemSettings`（`permission: null`）と `loadSystemSettings()` が
 * 全項目を返していたために、**インスタンスの運用地域が未認証の 1 リクエストで分かる**状態になった。
 * ルート 1 ファイルで応答を組み立て直しても、次に同じ口を足す人が同じ穴を開ける。
 * **認可の文脈を持たない口が、そもそも `analyticsTimeZone` に触れないようにする。**
 */
export interface PublicSystemSettings {
  readonly serviceName: string;
  readonly rememberMeEnabled: boolean;
}

/**
 * 未認証で読んでよい項目へ射影する。
 *
 * **読み方は変えていない。** 全項目版と同じ規則で読み、載せる範囲を狭めるだけ
 * （`toSystemSettings` に委ねるので、既定値や壊れた値の扱いが二重にならない）。
 */
export function toPublicSystemSettings(stored: ReadonlyMap<string, unknown>): PublicSystemSettings {
  const { serviceName, rememberMeEnabled } = toSystemSettings(stored);
  return { serviceName, rememberMeEnabled };
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
