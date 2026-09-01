/**
 * リダイレクト型認証の State（`04_認証設計.md` §27、025-redirect-authentication 設計 §6）。
 *
 * OIDC 等の外部認証は、ブラウザを認可エンドポイントへ送り出し、
 * コールバックで戻ってくるという**往復**で成立する。
 * その往復を結び付けるのが State であり、
 *
 * * 認可要求と一緒に外部 Provider へ渡り、そのまま返ってくる
 * * **一度しか使えない**
 * * **短い時間で切れる**
 *
 * という性質によって、コールバックの偽造（ログイン CSRF）を防ぐ。
 *
 * **State の発行と照合は Core が持つ。Plugin ごとに実装させない。**
 * どれか1つの Plugin が検証を書き忘れるだけで、その環境の認証全体が穴になる。
 */

/** State に束縛される情報。**Domain 層。DB も HTTP も知らない。** */
export interface AuthorizationState {
  readonly id: string;
  /** 認可開始を行った Authentication Provider。差し替わっていたら受け付けない。 */
  readonly providerId: string;
  /**
   * 外部 Provider へ渡した nonce。
   *
   * Core が保証するのは「新鮮・この往復専用・一度きり」まで。
   * ID Token の `nonce` Claim との照合は Plugin が行う（Core は JWT を解釈しない）。
   */
  readonly nonce: string;
  /** Core が Plugin へ渡した redirect_uri。コールバック時に同じ値かを照合する。 */
  readonly redirectUri: string;
  /** ログイン後の遷移先。**アプリ内の絶対パスだけ。** */
  readonly returnTo: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/**
 * State の有効期限。
 *
 * 往復そのものは数十秒で終わるが、外部 Provider 側で多要素認証を挟むことがある。
 * 短すぎると入力の途中で切れ、長すぎると盗まれたときに危ない。
 * `RESET_TOKEN_LIFETIME_MS`（1時間）より短くしているのはこのため。
 */
export const AUTHORIZATION_STATE_LIFETIME_MS = 10 * 60 * 1000;

/** その State が今この瞬間に使えるかを判定する。 */
export function isAuthorizationStateUsable(state: AuthorizationState, now: Date): boolean {
  if (state.usedAt !== null) {
    // 使い捨て。**同じ state を2回通せると、盗まれた state を何度でも使える。**
    return false;
  }
  return state.expiresAt.getTime() > now.getTime();
}

/**
 * ログイン後の遷移先として安全かを判定する。
 *
 * **Core が検証する。Plugin に検証させない。**
 * Open Redirect は「1箇所で漏れれば終わり」の類の穴であり、
 * Plugin ごとに書かせる理由が無い。
 */
export function isSafeReturnTo(path: string): boolean {
  if (!path.startsWith('/')) {
    // 絶対 URL（`https://…`）もスキーム付き（`javascript:`）もここで落ちる。
    return false;
  }
  if (path.startsWith('//')) {
    // プロトコル相対 URL。`//evil.example` は外部へ飛ぶ。
    return false;
  }
  if (path.startsWith('/\\')) {
    // 一部のブラウザが `/\` を `//` と同じに解釈する。
    return false;
  }
  // 制御文字・空白（ヘッダ分割や、目で見て気づけない細工を避ける）。
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * 遷移先を安全な値に丸める。
 *
 * **拒否ではなく既定へ落とす。** 遷移先が怪しいことは、
 * 認証そのものを失敗させる理由にならない。
 */
export function safeReturnTo(path: string | null | undefined): string {
  if (path === null || path === undefined) {
    return '/';
  }
  return isSafeReturnTo(path) ? path : '/';
}
