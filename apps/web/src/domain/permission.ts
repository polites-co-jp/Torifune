/**
 * Permission 名（04_認証設計.md §14、03_プラグイン設計.md §20.2）。
 *
 * **固定の union 型にしない。** そうすると Plugin が自分の Permission を足せなくなる。
 * 文字列に形式の制約だけを課し、実在するかは実行時のレジストリで見る。
 */

/**
 * `<resource>.<action>` 形式。ドットで2つ以上の区切りを許す（Plugin の名前空間用）。
 *
 * **ハイフンを許す。** Plugin ID がハイフンを含むため（`seo-plugin.report.read`）、
 * 許さないと Plugin が自分の ID を名前空間にできない。
 * DB 側の制約は migrations/008 で合わせてある。
 */
const PERMISSION_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

export type PermissionName = string & { readonly __brand?: 'PermissionName' };

export function isValidPermissionName(value: string): boolean {
  return PERMISSION_PATTERN.test(value) && value.length <= 100;
}

export class InvalidPermissionNameError extends Error {
  constructor(readonly value: string) {
    super('Permission 名の形式が不正');
    this.name = 'InvalidPermissionNameError';
  }
}

export function toPermissionName(value: string): PermissionName {
  if (!isValidPermissionName(value)) {
    throw new InvalidPermissionNameError(value);
  }
  return value;
}

/** `system.*` は本体が予約する。Plugin に取らせない。 */
export function isReservedPermissionNamespace(value: string): boolean {
  return value.startsWith('system.');
}

/**
 * Torifune 本体が定義する Permission。マイグレーションの投入内容と一致させる。
 *
 * **コンテンツは Core の責務ではない**（`docs/仕様書/改訂履歴.md` 2026-08-24）。
 * コンテンツを扱う Plugin は、自身の Permission を Plugin ID の名前空間で登録する。
 *
 * `system.manage` を要求する UseCase はまだ無い。
 * `01_スプリント計画.md` S3 が体系として先に確定させたもので、
 * 実際の消費先はシステム設定（`06_画面設計.md` §16）＝ `015-settings` になる。
 * **未使用に見えても外さない。** マイグレーションの投入内容と
 * administrator への割り当てがこの一覧と対応している。
 */
export const CORE_PERMISSIONS = [
  'site.read',
  'site.write',
  'site.delete',
  'social.read',
  'social.write',
  'social.delete',
  'user.manage',
  'plugin.manage',
  'token.manage',
  'system.manage',
] as const;

export type CorePermission = (typeof CORE_PERMISSIONS)[number];

/**
 * 高い権限を要求する Permission（06_画面設計.md §39）。
 *
 * **導入前に強調して警告する。** 権限コードを並べるだけでは、
 * 読む人はどれが危険かを判断できない。
 *
 * この3つは、与えた時点で Torifune 全体を掌握しうる。
 * 他のユーザーを作れれば管理者を作れ、Plugin を入れられれば任意のコードを
 * 動かせ、システム設定を変えられれば認証方式ごと差し替えられる。
 */
export const HIGH_PRIVILEGE_PERMISSIONS: readonly CorePermission[] = [
  'system.manage',
  'user.manage',
  'plugin.manage',
  // API Token はアカウントの分身を作る操作。
  'token.manage',
];

export function isHighPrivilegePermission(permission: string): boolean {
  return (HIGH_PRIVILEGE_PERMISSIONS as readonly string[]).includes(permission);
}

/**
 * Permission の説明。
 *
 * 画面へ出す言葉は「その権限で何ができるか」にする。
 * `site.write` と書かれても、読む人は何を許すのか分からない。
 */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<CorePermission, string>> = {
  'site.read': 'Webサイトの一覧と詳細を見る',
  'site.write': 'Webサイトを作成・変更する',
  'site.delete': 'Webサイトを削除する',
  'social.read': 'SNSアカウントと投稿を見る',
  'social.write': 'SNSアカウントと投稿を作成・変更する',
  'social.delete': 'SNSアカウントと投稿を削除する',
  'user.manage': 'ユーザーとロールを管理する（管理者を作れる）',
  'plugin.manage': 'プラグインを導入・有効化する（任意のコードを動かせる）',
  'token.manage': 'APIトークンを発行・失効する（アカウントの分身を作れる）',
  'system.manage': 'システム全体の設定を変更する（認証方式を差し替えられる）',
};

export function describePermission(permission: string): string | null {
  return (PERMISSION_DESCRIPTIONS as Record<string, string>)[permission] ?? null;
}
