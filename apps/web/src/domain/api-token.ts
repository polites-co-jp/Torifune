import { createHash, randomBytes } from 'node:crypto';
import type { PermissionName } from './permission';

/**
 * API Token（05_API設計.md §37-38）。
 *
 * 設計は docs/設計/021-api-token/設計.md。
 */

/** 256bit。総当たりが成立しない長さ。 */
export const API_TOKEN_BYTES = 32;

/**
 * 見分けるための接頭辞。
 *
 * ログや設定ファイルに紛れ込んだときに「これは Torifune の Token だ」と
 * 気づけるようにする。秘密漏洩の検出（GitHub の secret scanning など）でも
 * 手がかりになる。
 */
export const API_TOKEN_PREFIX = 'tfp_';

/** 一覧に出す識別用の長さ。これだけでは認証に使えない。 */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 8;

export interface GeneratedApiToken {
  /** 発行時に一度だけ返す平文。**保存しない。** */
  readonly plaintext: string;
  readonly tokenHash: string;
  /** 一覧で見分けるための先頭部分。 */
  readonly prefix: string;
}

export function generateApiToken(): GeneratedApiToken {
  const plaintext = `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_BYTES).toString('base64url')}`;
  return {
    plaintext,
    tokenHash: hashApiToken(plaintext),
    prefix: plaintext.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * DB へ保存する形に変換する。
 *
 * セッショントークンと同じ理由で SHA-256。十分な長さの乱数なので
 * 総当たりが成立せず、毎リクエストで Argon2 を回すのは遅すぎる。
 */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface ApiToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly PermissionName[];
  /** null は無期限。 */
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export const API_TOKEN_NAME_MAX_LENGTH = 100;

export function isValidApiTokenName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= API_TOKEN_NAME_MAX_LENGTH;
}

/** 使える状態か。失効・期限切れを弾く。 */
export function isUsable(token: ApiToken, now: Date): boolean {
  if (token.revokedAt !== null) {
    return false;
  }
  return token.expiresAt === null || token.expiresAt.getTime() > now.getTime();
}

/**
 * 実効 Permission を求める。
 *
 * **所有者のいまの Permission と Scope の交差**を取る。
 * 固定した Scope をそのまま信じると、ロールを外されたユーザーの Token が
 * 外す前の権限で動き続ける。**Token は権限を増やせない。絞るだけ。**
 */
export function effectiveTokenPermissions(
  ownerPermissions: ReadonlySet<PermissionName>,
  scopes: readonly PermissionName[],
): ReadonlySet<PermissionName> {
  return new Set(scopes.filter((scope) => ownerPermissions.has(scope)));
}

/** `Authorization: Bearer <token>` から値を取り出す。無ければ null。 */
export function bearerTokenOf(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
