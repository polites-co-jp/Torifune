'use client';

import { useEffect } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Spinner } from '@/ui/components';

/**
 * ログアウト。
 *
 * サーバー側のセッションを失効させてからログイン画面へ送る。
 * Cookie を消すだけでは、Cookie を控えていれば再利用できてしまう。
 */
export default function LogoutPage() {
  useEffect(() => {
    void apiRequest('/api/v1/auth/logout', { method: 'POST', body: {} }).finally(() => {
      window.location.assign('/login');
    });
  }, []);

  return (
    <main style={{ padding: 'var(--tf-space-8)' }}>
      <Spinner label="ログアウトしています" />
    </main>
  );
}
