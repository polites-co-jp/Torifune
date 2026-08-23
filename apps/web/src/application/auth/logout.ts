import { getAuthenticationProvider } from '../../authentication/registry';
import { withTransaction } from '../transaction';
import { authContext, type RequestInfo } from './context';

/**
 * ログアウト UseCase。
 *
 * サーバー側のセッションを失効させる（04_認証設計.md §10）。
 * Cookie を消すだけでは、Cookie を控えていれば再利用できてしまう。
 */
export async function logout(sessionToken: string, request: RequestInfo): Promise<void> {
  const provider = getAuthenticationProvider();
  await withTransaction(async (tx) => {
    await provider.logout(sessionToken, authContext(tx, request));
  });
}
