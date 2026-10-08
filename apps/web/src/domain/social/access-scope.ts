/**
 * 区画（`AccessScope`）：要求が SNS のアカウントと投稿を「どこまで見えて使えるか」（053-site-scoped-social 設計 §5）。
 *
 * * `all`：画面のセッション・配信ジョブ・Plugin の文脈（区画で絞らない。設計 §5.4）
 * * `common`：サイトに紐づかない API トークン
 * * `site`：サイトに紐づいた API トークン
 *
 * 区画を決めるのは `application/social/access-scope.ts` の `scopeOf` だけ（設計 §8.1）。
 * ここは値（サイト ID・真偽）だけを受け取る純関数で、DB 製品にも Plugin API にも依存しない。
 * SQL の述語（Infrastructure の `scopePredicate`）は同じ表（設計 §5.2・§7.4）を実装する。
 */
export type AccessScope =
  | { readonly kind: 'all' } // 画面のセッション・配信ジョブ・Plugin（区画で絞らない。§5.4）
  | { readonly kind: 'common' } // 共通のトークン
  | { readonly kind: 'site'; readonly siteId: string }; // サイトのトークン

/** 区画で絞らない文脈（画面のセッション・内部処理）。 */
export const ALL_SCOPE: AccessScope = { kind: 'all' };

/** アカウントを変更・削除できるか（設計 §8.1）。`forbidden` は見えるが変えられない（`site` から見た共通）。 */
export type AccountManageability = 'ok' | 'forbidden' | 'not_found';

/** 投稿の区画を決める値（設計 §5.2・§7.3）。 */
export interface PostScopeFacts {
  /** 投稿先のアカウントの `site_id`。 */
  readonly accountSiteId: string | null;
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

/** 投稿の登録元の区画（`social_posts.origin_site_id` / `origin_site_scoped`。設計 §7.3）。 */
export interface PostOrigin {
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

export type AccountSiteResolution =
  | { readonly ok: true; readonly siteId: string | null }
  | { readonly ok: false; readonly message: string };

export type AccountSiteChangeCheck =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** 設計 §8.2.3：共通のトークンがアカウントをサイトに紐づけようとした。 */
const MESSAGE_COMMON_TOKEN_CANNOT_LINK =
  'APIトークンではアカウントをサイトに紐づけられません。管理画面で紐づけてください。';
/** 設計 §8.2.3：サイトのトークンが自分のサイト以外を指定した（サイトの存在を教えないため文言は 1 つ）。 */
const MESSAGE_SITE_TOKEN_OTHER_SITE =
  'サイトに紐づいたトークンでは、そのサイト以外を指定できません。';
/** 設計 §8.2.4：トークンがアカウントのサイトを付け替えようとした。 */
const MESSAGE_TOKEN_CANNOT_CHANGE_SITE =
  'APIトークンではアカウントのサイトを変えられません。管理画面で変えてください。';

/** 設計 §5.2 のアカウントの表の「見える」。見えるアカウントは投稿先にできる（「使える」）。 */
export function accountVisible(scope: AccessScope, accountSiteId: string | null): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'common':
      return accountSiteId === null;
    case 'site':
      return accountSiteId === null || accountSiteId === scope.siteId;
  }
}

/**
 * アカウントを変更・削除できるか（設計 §5.2・§5.5）。
 *
 * 見えなければ `not_found`（404）。サイトのトークンから見た共通のアカウントは、見えるが変えられない `forbidden`（403）。
 */
export function accountManageable(
  scope: AccessScope,
  accountSiteId: string | null,
): AccountManageability {
  if (!accountVisible(scope, accountSiteId)) {
    return 'not_found';
  }
  if (scope.kind === 'site' && accountSiteId === null) {
    return 'forbidden';
  }
  return 'ok';
}

/**
 * 設計 §5.2 の投稿の表。
 *
 * アカウントがサイト専用ならそのサイトの投稿、共通なら登録元の区画（`origin_*`）で決まる。
 * 登録したサイトが消えた投稿（`originSiteScoped` で `originSiteId` が null）はどのトークンからも見えない。
 */
export function postVisible(scope: AccessScope, facts: PostScopeFacts): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'common':
      return facts.accountSiteId === null && !facts.originSiteScoped;
    case 'site':
      if (facts.accountSiteId !== null) {
        return facts.accountSiteId === scope.siteId;
      }
      return facts.originSiteId === scope.siteId;
  }
}

/** トークン以外の登録で書く登録元の区画（設計 §7.3）。トークンの登録はトークンの行の値を書く。 */
export function originOf(scope: AccessScope): PostOrigin {
  if (scope.kind === 'site') {
    return { originSiteId: scope.siteId, originSiteScoped: true };
  }
  return { originSiteId: null, originSiteScoped: false };
}

/**
 * アカウントの作成で `siteId` をどう決めるか（設計 §8.2.3 の表）。`requested` の省略は `undefined`。
 *
 * サイトの存在は確かめない（区画 `all` のときに呼び出し側が確かめる）。
 */
export function resolveAccountSiteOnCreate(
  scope: AccessScope,
  requested: string | null | undefined,
): AccountSiteResolution {
  switch (scope.kind) {
    case 'all':
      return { ok: true, siteId: requested ?? null };
    case 'common':
      return requested === undefined || requested === null
        ? { ok: true, siteId: null }
        : { ok: false, message: MESSAGE_COMMON_TOKEN_CANNOT_LINK };
    case 'site':
      // サイトのトークンが作るアカウントはそのサイトに自動で紐づく。
      return requested === undefined || requested === scope.siteId
        ? { ok: true, siteId: scope.siteId }
        : { ok: false, message: MESSAGE_SITE_TOKEN_OTHER_SITE };
  }
}

/**
 * アカウントの更新で `siteId` を送ったときの判定（設計 §8.2.4 の表）。
 *
 * 付け替えられるのは区画 `all`（画面）だけ。トークンは今と同じ値なら通す（何も変わらない）。
 * サイトの存在は確かめない（区画 `all` のときに呼び出し側が確かめる）。
 */
export function checkAccountSiteChange(
  scope: AccessScope,
  currentSiteId: string | null,
  requested: string | null,
): AccountSiteChangeCheck {
  if (scope.kind === 'all' || currentSiteId === requested) {
    return { ok: true };
  }
  return { ok: false, message: MESSAGE_TOKEN_CANNOT_CHANGE_SITE };
}
