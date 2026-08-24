/**
 * 認証済みユーザーの統一表現（04_認証設計.md §16）。
 *
 * 認証方式が標準認証でも OIDC でも、本体はこの型だけを見る。
 * 「標準認証だから」という分岐を本体のどこにも作らないための型。
 *
 * **外部 Provider 固有の情報をここへ持ち込まない。**
 * 持ち込むと、その Provider が無い環境で本体が壊れる。
 */
export interface UserIdentity {
  /** Torifune 内部のユーザーID。 */
  readonly userId: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
  /** 認証した Provider の識別子（`local` / `oidc` など）。 */
  readonly providerId: string;
  /** 外部 Provider におけるユーザーID。標準認証では null。 */
  readonly externalUserId: string | null;
}

/**
 * API レスポンスや画面へ渡す形。
 *
 * `UserIdentity` をそのまま返さないのは、内部の識別子が増えたときに
 * 意図せず外へ出るのを避けるため。**明示的に選んだものだけを返す。**
 */
export interface PublicUser {
  readonly id: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
}

export function toPublicUser(identity: UserIdentity): PublicUser {
  return {
    id: identity.userId,
    loginId: identity.loginId,
    displayName: identity.displayName,
    email: identity.email,
  };
}
