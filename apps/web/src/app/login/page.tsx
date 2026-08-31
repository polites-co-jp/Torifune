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
            Plugin による追加のログイン手段は、ここへ差し込む（06_画面設計.md §5-6）。

            拡張点の名前 `login.methods` は `CORE_EXTENSION_POINTS` にあるが、
            **まだ枠を置かない。** ログイン手段を足す Plugin は Authentication
            Provider を登録できて初めて意味を持つが、その登録口は保留にしてある
            （`03_リスクと未決事項.md` S-6）。描画枠だけ先に作ると、登録しても
            ログインできない拡張点が動いているように見える。
            S-6 が決着したときに枠を入れ、`ui-shell.test.ts` の PENDING から外す。
          */}
        </>
      }
    />
  );
}
