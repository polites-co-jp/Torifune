import { notFound } from 'next/navigation';
import { isSetupOpen } from '@/application/auth/setup';
import { AuthForm } from '@/ui/auth-form';

// 管理者の有無を毎回確認する。静的化するとセットアップ済みでも開いたままになる。
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  // 管理者が1人でもいれば 404。「セットアップ済みです」とも表示しない（状態を漏らさない）。
  if (!(await isSetupOpen())) {
    notFound();
  }

  return (
    <AuthForm
      title="最初の管理者を作成"
      submitLabel="作成する"
      endpoint="/api/v1/setup"
      redirectTo="/login"
      fields={[
        { name: 'loginId', label: 'ログインID', type: 'text', autoComplete: 'username' },
        { name: 'displayName', label: '表示名', type: 'text', autoComplete: 'name' },
        { name: 'email', label: 'メールアドレス', type: 'email', autoComplete: 'email' },
        { name: 'password', label: 'パスワード', type: 'password', autoComplete: 'new-password' },
      ]}
    />
  );
}
