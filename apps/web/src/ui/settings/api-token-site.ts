import { SITE_COMMON_LABEL, SITE_UNNAMED_LABEL } from '@/ui/social/labels';

/**
 * 設定 → API のトークンのサイト（053-site-scoped-social 設計 §9.2・§9.2.1）。
 *
 * **純関数と文言の置き場。** `'use client'` の部品（`api-settings.tsx`）に純関数を置くと、
 * 単体テストから部品の値を引き込むことになる（053 実装プラン §8 の 13）。
 * 「サイト」「共通」「サイト専用」は `/social` と同じ言い方なので `ui/social/labels.ts` の定数を使う。
 */

/* -------------------------------------------------------------------------- */
/* 文言                                                                         */
/* -------------------------------------------------------------------------- */

/** 発行フォームと「サイトを変える」の Modal の「共通」の選択肢（設計 §9.2）。 */
export const TOKEN_SITE_COMMON_OPTION = '共通（サイトに紐づけない）';
export const TOKEN_SITE_DESCRIPTION =
  'サイトを選ぶと、このトークンはそのサイトの SNS アカウントと共通の SNS アカウントだけを使えます。付けられる権限は SNS の 4 つだけです。サイトは後から変えられます。';
/** 共通を選んでいるときの補足（設計 §9.2。裁定 5）。 */
export const TOKEN_SITE_COMMON_INFO =
  '共通のトークンは、サイトに紐づいていない SNS アカウントだけを使えます。';
/** サイトのトークンでサイトが削除されたもの（`siteScoped && siteId === null`）。 */
export const TOKEN_SITE_DELETED_LABEL = '削除されたサイト';

/** 一覧の行のボタン（設計 §9.2.1）。 */
export const TOKEN_SITE_CHANGE_LABEL = 'サイトを変える';
export const TOKEN_SITE_CHANGE_TITLE = 'トークンのサイトを変える';
export const TOKEN_SITE_CHANGE_SUBMIT = '変える';
export const TOKEN_SITE_EMPTY_SCOPES_NOTE =
  '権限が 1 つも残らないため、このトークンでは何もできなくなります。';
/** 裁定 10 の注意（設計 §9.2.1）。 */
export const TOKEN_SITE_MOVE_NOTE =
  'このトークンが共通のアカウントへ登録した投稿は、変更後の区画へ移ります。サイト専用のアカウントと、このトークンが作ったアカウントは元のサイトに残り、変更後は見えなくなることがあります。';
export const TOKEN_SITE_CHANGED = 'トークンのサイトを変えました。';

/** 選んだ先がサイトで、今の Scope に SNS 以外のものがあるときの警告（設計 §9.2.1）。 */
export function tokenSiteRemovedScopesWarning(removed: readonly string[]): string {
  return `このサイトに紐づけると、次の権限が外れます：${removed.join(', ')}`;
}

/* -------------------------------------------------------------------------- */
/* 純関数                                                                       */
/* -------------------------------------------------------------------------- */

/** 部品が受け取るサイト（Server Component が `listSites` から組む。設計 §9.2）。 */
export interface TokenSiteOption {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'paused' | 'archived';
}

/**
 * サイトに紐づけたときに外れる Scope（今の Scope のうち `siteTokenScopes` に無いもの。今の並びのまま）。
 * 選んだ先が共通（`siteId === null`）なら何も外れない。
 */
export function removedTokenScopes(input: {
  readonly siteId: string | null;
  readonly currentScopes: readonly string[];
  readonly siteTokenScopes: readonly string[];
}): readonly string[] {
  if (input.siteId === null) return [];
  return input.currentScopes.filter((scope) => !input.siteTokenScopes.includes(scope));
}

/** `PATCH /api/v1/api-tokens/{id}` の本文（053 設計 §8.5.6）。 */
export interface ChangeTokenSiteRequestBody {
  readonly siteId: string | null;
  readonly scopes?: readonly string[];
}

/**
 * 「サイトを変える」で送る本文（設計 §9.2.1）。
 *
 * `scopes` は「今の Scope ∩ `siteTokenScopes`」。**外れるものが無ければ `scopes` を送らない**
 * （サーバは省略を「今のまま」と読む）。外れるものがあって残りが空なら `scopes: []` を送る。
 */
export function changeTokenSiteRequestBody(input: {
  readonly siteId: string | null;
  readonly currentScopes: readonly string[];
  readonly siteTokenScopes: readonly string[];
}): ChangeTokenSiteRequestBody {
  if (removedTokenScopes(input).length === 0) {
    return { siteId: input.siteId };
  }
  return {
    siteId: input.siteId,
    scopes: input.currentScopes.filter((scope) => input.siteTokenScopes.includes(scope)),
  };
}

/**
 * 一覧の「サイト」列の表示（設計 §9.2）：サイトの名前／「共通」／「削除されたサイト」／
 * 名前を引けなければ「サイト専用」。
 */
export function tokenSiteLabel(
  token: { readonly siteId: string | null; readonly siteScoped: boolean },
  sites: readonly TokenSiteOption[],
): string {
  if (token.siteId === null) {
    return token.siteScoped ? TOKEN_SITE_DELETED_LABEL : SITE_COMMON_LABEL;
  }
  return sites.find((site) => site.id === token.siteId)?.name ?? SITE_UNNAMED_LABEL;
}
