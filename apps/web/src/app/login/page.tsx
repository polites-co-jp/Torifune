import Link from 'next/link';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';
import { AuthForm } from '@/ui/auth-form';
import { PublicExtensionPoint } from '@/ui/plugin/plugin-slot';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // **認証を通す前に Plugin を起動する。**
  // 認証方式を差し替える Plugin は、ここより前に起動していなければ
  // ログイン手段を出すことも、その認証を通すこともできない。
  await ensurePluginsStartedAnonymously();

  return (
    <AuthForm
      title="ログイン"
      submitLabel="ログイン"
      endpoint="/api/v1/auth/login"
      redirectTo="/"
      fields={[
        { name: 'loginId', label: 'ログインID', type: 'text', autoComplete: 'username' },
        {
          name: 'password',
          label: 'パスワード',
          type: 'password',
          autoComplete: 'current-password',
        },
      ]}
      footer={
        <>
          <Link href="/password-reset" style={{ color: 'var(--tf-color-primary)' }}>
            パスワードを忘れた場合
          </Link>
          {/*
            Plugin による追加のログイン手段（06_画面設計.md §5-6）。

            **Data API を渡さない。** 見ているのがまだ誰とも分からない相手だから。
            Permission を要求する登録も描画されない（権限は空集合として扱う）。
          */}
          <PublicExtensionPoint point="login.methods" />
        </>
      }
    />
  );
}
