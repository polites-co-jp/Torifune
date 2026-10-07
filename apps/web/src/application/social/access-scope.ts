import {
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { ALL_SCOPE, type AccessScope } from '@/domain/social/access-scope';

/**
 * 認可の文脈から SNS の区画を決める**唯一の入口**（053-site-scoped-social 設計 §8.1）。
 *
 * * `apiToken` が無い（画面のセッション・内部処理・Plugin の文脈）→ `all`
 * * `apiToken.siteId` が null で `siteScoped` が偽（共通のトークン）→ `common`
 * * `apiToken.siteId` がサイト（サイトのトークン）→ `site`
 * * `apiToken.siteId` が null で `siteScoped` が真（サイトの消えたサイトのトークン）→ **`UnauthenticatedError`**。
 *   文脈を作る段（`buildApiTokenContext`）で未認証にしているので普通は届かないが、届いても共通の区画に化けさせない
 *   （fail closed。053 受け入れ条件 #101）
 *
 * `apiToken` は `buildApiTokenContext` がトークンの行から積む。**要求の値から区画を決める経路を作らない。**
 * 区画の値（`kind: 'site'`）を組み立てるのはここだけ（受け入れ条件 #64）。
 */
export function scopeOf(context: AuthorizationContext): AccessScope {
  const apiToken = context.apiToken;
  if (apiToken === undefined) {
    return ALL_SCOPE;
  }
  if (apiToken.siteId === null) {
    if (apiToken.siteScoped) {
      throw new UnauthenticatedError();
    }
    return { kind: 'common' };
  }
  return { kind: 'site', siteId: apiToken.siteId };
}
