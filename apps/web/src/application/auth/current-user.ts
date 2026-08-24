import { getAuthenticationProvider } from '../../authentication/registry';
import type { UserIdentity } from '../../authentication/identity';
import { withConnection } from '../transaction';
import { authContext, type RequestInfo } from './context';

/**
 * セッショントークンから現在のユーザーを得る。
 *
 * **毎リクエストで DB を引く。** キャッシュすると、ユーザーを無効化した直後に
 * キャッシュが生きている間だけ操作できてしまう。
 * 速度が問題になるまで素直な実装にする。
 */
export async function getCurrentUser(
  sessionToken: string | undefined,
  request: RequestInfo,
): Promise<UserIdentity | null> {
  if (sessionToken === undefined || sessionToken === '') {
    return null;
  }

  const provider = getAuthenticationProvider();

  return withConnection(async (connection) => {
    const context = authContext(connection, request);
    const identity = await provider.getIdentity(sessionToken, context);
    if (identity !== null) {
      // 最終アクセス時刻を更新し、アイドルタイムアウトを延ばす。
      await provider.refresh(sessionToken, context);
    }
    return identity;
  });
}
