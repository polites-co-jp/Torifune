/**
 * Torifune を利用するユーザー。
 *
 * **Domain 層。** Argon2 も Cookie も HTTP も知らない。
 * 「パスワードが正しいか」の判定は Authentication 層の責務であり、ここには無い。
 */

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface User {
  readonly id: string;
  readonly loginId: string;
  readonly email: string;
  readonly displayName: string;
  /** 外部認証だけを使うユーザーは持たない。 */
  readonly passwordHash: string | null;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastLoginAt: Date | null;
}

/** 新規登録に必要な入力。 */
export interface NewUser {
  readonly id: string;
  readonly loginId: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
}

/** ログインできる状態かを判定する。 */
export function canSignIn(user: User): boolean {
  return user.status === 'active' && user.passwordHash !== null;
}

export const LOGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

export function isValidLoginId(value: string): boolean {
  return LOGIN_ID_PATTERN.test(value);
}

/**
 * メールアドレスの形式を検査する。
 *
 * RFC に厳密には従わない。厳密な検証は誤って正当なアドレスを弾くほうが害が大きく、
 * 実在性はどのみち到達確認でしか分からない。
 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= 254;
}
