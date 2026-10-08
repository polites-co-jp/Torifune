import type { SocialPost } from './social';

/**
 * 投稿の登録元（054-bulk-post-actions 設計 §5.6・§7.3・§8.8）。
 *
 * 投稿一覧の「登録元」の列と絞り込みに使う。登録元は**投稿を登録したトークンの名前**で、トークンを経ない登録は
 * 画面（セッション）とみなす。ここは値だけを受け取る純関数で、DB 製品にも Plugin API にも依存しない。
 */
export type PostSource =
  | { readonly kind: 'screen' }
  | {
      readonly kind: 'token';
      readonly tokenId: string;
      readonly name: string;
      readonly revoked: boolean;
    }
  | { readonly kind: 'deleted_token'; readonly name: string };

/** 一覧の登録元の絞り込み。 */
export type PostSourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

/** 投稿を登録したトークン（区画から見える投稿のもの。失効を含む）。 */
export interface PostSourceToken {
  readonly id: string;
  readonly name: string;
  readonly revoked: boolean;
  readonly createdAt: Date;
}

/** 登録元の一覧（設計 §8.8）。行の表示と絞り込みの選択肢の両方に使う。 */
export interface SocialPostSources {
  /** 区画から見える投稿を登録したトークン（失効を含む）。名前 → 発行日時 → ID の順。 */
  readonly tokens: readonly PostSourceToken[];
  /** 画面（トークンを経ない）で登録した投稿があるか。 */
  readonly hasScreenPosts: boolean;
  /** トークンの行が消えた投稿があるか。 */
  readonly hasDeletedTokenPosts: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** クエリの値（設計 §9.2 の `postSource`）。 */
const SCREEN_PARAM = 'screen';
const DELETED_PARAM = 'deleted';
const TOKEN_PARAM_PREFIX = 'token:';

/**
 * 投稿の登録元（設計 §8.8 の末尾の規則）。
 *
 * * `createdByTokenId` があり対応表にある → `token`（名前と失効は対応表から）
 * * 対応表に無い → `token`（名前は写し、失効は偽）
 * * `createdByTokenId` が NULL で写しがある → `deleted_token`
 * * 両方 NULL → `screen`
 */
export function postSourceOf(
  post: Pick<SocialPost, 'createdByTokenId' | 'createdByTokenName'>,
  tokens: readonly PostSourceToken[],
): PostSource {
  if (post.createdByTokenId !== null) {
    const token = tokens.find((candidate) => candidate.id === post.createdByTokenId);
    if (token !== undefined) {
      return { kind: 'token', tokenId: token.id, name: token.name, revoked: token.revoked };
    }
    return {
      kind: 'token',
      tokenId: post.createdByTokenId,
      name: post.createdByTokenName ?? '',
      revoked: false,
    };
  }
  if (post.createdByTokenName !== null) {
    return { kind: 'deleted_token', name: post.createdByTokenName };
  }
  return { kind: 'screen' };
}

/**
 * クエリの `postSource` を読む（設計 §9.2）。誤った値は null（絞らない）。
 *
 * `'screen'` / `'deleted'` / `'token:<UUID>'` だけを受け付ける。トークンの ID は小文字にそろえる。
 */
export function parsePostSourceParam(value: unknown): PostSourceFilter | null {
  if (typeof value !== 'string') return null;
  if (value === SCREEN_PARAM) return { kind: 'screen' };
  if (value === DELETED_PARAM) return { kind: 'deleted_token' };
  if (value.startsWith(TOKEN_PARAM_PREFIX)) {
    const tokenId = value.slice(TOKEN_PARAM_PREFIX.length);
    if (UUID_PATTERN.test(tokenId)) {
      return { kind: 'token', tokenId: tokenId.toLowerCase() };
    }
  }
  return null;
}

/** 絞り込みをクエリの値にする（`parsePostSourceParam` の逆）。 */
export function postSourceParamOf(filter: PostSourceFilter): string {
  switch (filter.kind) {
    case 'screen':
      return SCREEN_PARAM;
    case 'deleted_token':
      return DELETED_PARAM;
    case 'token':
      return `${TOKEN_PARAM_PREFIX}${filter.tokenId}`;
  }
}
