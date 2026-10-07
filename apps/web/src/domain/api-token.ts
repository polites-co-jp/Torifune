import { createHash, randomBytes } from 'node:crypto';
import type { PermissionName } from './permission';
import type { SiteStatus } from './site/site';

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

/**
 * サイトのトークンに付けられる Scope（053-site-scoped-social 設計 §7.2・裁定 6）。
 *
 * 区画は SNS の UseCase にしか無いので、SNS 以外を許すと「サイトに限定したトークン」が SNS 以外では全体に届く。
 * 発行時（422）・使用時（`effectiveSiteTokenPermissions`）・DB（`026` の `api_tokens_site_scopes_check`）の 3 か所で守る。
 * **`026` の CHECK の配列と一致させる**（静的検査で固定している）。
 */
export const SITE_TOKEN_SCOPES = [
  'social.read',
  'social.write',
  'social.delete',
  'social.approve',
] as const satisfies readonly PermissionName[];

export type SiteTokenScope = (typeof SITE_TOKEN_SCOPES)[number];

export function isSiteTokenScope(value: string): value is SiteTokenScope {
  return (SITE_TOKEN_SCOPES as readonly string[]).includes(value);
}

export interface SiteTokenUsableInput {
  readonly siteScoped: boolean;
  readonly siteId: string | null;
  /** 紐づいたサイトの状態。サイトが無ければ null。 */
  readonly siteStatus: SiteStatus | null;
}

/**
 * サイトのトークンとして使える状態か（設計 §8.5.3）。共通のトークンは常に真。
 *
 * サイトが削除された（`siteId` が null）・サイトが無い・アーカイブされたサイトのトークンは使えない。
 * `paused` は影響しない。
 */
export function siteTokenUsable(input: SiteTokenUsableInput): boolean {
  if (!input.siteScoped) {
    return true;
  }
  if (input.siteId === null || input.siteStatus === null) {
    return false;
  }
  return input.siteStatus !== 'archived';
}

/**
 * サイトのトークンの実効 Permission：**所有者 ∩ Scope ∩ `SITE_TOKEN_SCOPES`**（設計 §8.5.3）。
 *
 * DB の CHECK をすり抜けた値（SNS 以外の Scope）もここで落とす。
 */
export function effectiveSiteTokenPermissions(
  ownerPermissions: ReadonlySet<PermissionName>,
  scopes: readonly PermissionName[],
): ReadonlySet<PermissionName> {
  return new Set(
    [...effectiveTokenPermissions(ownerPermissions, scopes)].filter((scope) =>
      isSiteTokenScope(scope),
    ),
  );
}

export interface ResolveTokenSiteChangeInput {
  readonly current: { readonly revokedAt: Date | null; readonly scopes: readonly PermissionName[] };
  /** 変更後のサイト。null は共通にする。 */
  readonly requestedSiteId: string | null;
  /** 変更後の Scope。省略すると今のまま。今の Scope の部分集合だけ（狭めるだけ）。 */
  readonly requestedScopes?: readonly string[];
  /** `requestedSiteId` のサイト。無ければ null（`requestedSiteId` が null のときは見ない）。 */
  readonly site: { readonly status: SiteStatus } | null;
}

export type TokenSiteChangeResolution =
  | {
      readonly ok: true;
      readonly siteId: string | null;
      readonly siteScoped: boolean;
      readonly scopes: readonly PermissionName[];
      /** 今の Scope のうち、変更で外れるもの。 */
      readonly removedScopes: readonly PermissionName[];
    }
  | { readonly ok: false; readonly field: 'siteId' | 'scopes'; readonly message: string };

/**
 * トークンのサイトの変更の判定（設計 §8.5.6 の表の 2〜7）。1 の 404（無い・他人のもの）は呼び出し側で先に判定する。
 *
 * SNS 以外の Scope を持つトークンをサイトへ変えるときは**黙って外さず断る**（`021` §2.3）。
 * 同じ要求で `requestedScopes` を SNS の範囲に狭めれば通る。
 */
export function resolveTokenSiteChange(
  input: ResolveTokenSiteChangeInput,
): TokenSiteChangeResolution {
  const { current, requestedSiteId, requestedScopes, site } = input;

  // 2. 失効は取り消せない。
  if (current.revokedAt !== null) {
    return { ok: false, field: 'siteId', message: '失効したトークンは変えられません。' };
  }

  // 3. 広げられない（今の Scope の部分集合だけ）。
  const currentScopes: readonly string[] = current.scopes;
  if (requestedScopes !== undefined) {
    const widened = requestedScopes.find((scope) => !currentScopes.includes(scope));
    if (widened !== undefined) {
      return {
        ok: false,
        field: 'scopes',
        message: `権限を広げることはできません: ${widened}`,
      };
    }
  }
  const scopes =
    requestedScopes === undefined
      ? [...current.scopes]
      : current.scopes.filter((scope) => requestedScopes.includes(scope));
  const removedScopes = current.scopes.filter((scope) => !scopes.includes(scope));

  if (requestedSiteId !== null) {
    // 4. サイトが存在する。
    if (site === null) {
      return { ok: false, field: 'siteId', message: 'Webサイトが見つかりません。' };
    }
    // 5. アーカイブしたサイトには紐づけない（裁定 8）。
    if (site.status === 'archived') {
      return {
        ok: false,
        field: 'siteId',
        message: 'アーカイブしたサイトにはトークンを紐づけられません。',
      };
    }
    // 6. サイトのトークンは SNS の Scope だけ（裁定 6）。
    const outside = scopes.filter((scope) => !isSiteTokenScope(scope));
    if (outside.length > 0) {
      return {
        ok: false,
        field: 'scopes',
        message: `サイトに紐づけるトークンには SNS の権限だけを指定できます。外す権限を scopes で指定し直してください: ${outside.join(', ')}`,
      };
    }
  }

  // 7.
  return {
    ok: true,
    siteId: requestedSiteId,
    siteScoped: requestedSiteId !== null,
    scopes,
    removedScopes,
  };
}

/** `Authorization: Bearer <token>` から値を取り出す。無ければ null。 */
export function bearerTokenOf(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
