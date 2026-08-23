import Link from 'next/link';
import { AuthForm } from '@/ui/auth-form';

export default function LoginPage() {
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
            Plugin による追加のログイン手段は、ここへ差し込む（06_画面設計.md §5）。
            拡張ポイント `login.methods` として 011-plugin-runtime で実装する。
          */}
        </>
      }
    />
  );
}
