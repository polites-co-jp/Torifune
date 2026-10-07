import type { ApiFailure } from '@/ui/client/api-client';

/**
 * Web サイトの削除の失敗を Toast の文にする（053-site-scoped-social 設計 §9.3）。
 *
 * 紐づいた SNS アカウントがあるときの 409 は、直し方を含む文を `details.socialAccounts` に載せて返る
 * （設計 §8.6）。それがあれば先頭の文を、無ければ今までどおり `message` を返す。
 * 文そのものはサーバの応答が持つ（画面に写しを持たない）。
 */
export function siteDeleteErrorText(error: ApiFailure): string {
  if (error.status === 409) {
    const first = error.details?.['socialAccounts']?.[0];
    if (first !== undefined && first !== '') {
      return first;
    }
  }
  return error.message;
}
