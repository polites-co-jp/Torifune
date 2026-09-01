import { AuthForm } from './auth-form';
import { Alert } from './components';

/**
 * パスワード再設定の入力画面（04_認証設計.md §24、019-notification 設計 §3.5）。
 *
 * トークンは URL のクエリで受ける。メール本文のリンクをそのまま踏める形で、
 * トークンが履歴や Referer に残る点は**単回使用・1時間期限**で緩和されている。
 *
 * **トークンはサーバー側で読む。** `useSearchParams()` を使うと Next.js が
 * クライアント描画へ退避し（BAILOUT_TO_CLIENT_SIDE_RENDERING）、
 * その shell には CSP の nonce が入らないため、スクリプトが全部ブロックされる。
 *
 * **結果を出し分けない。** トークンが無効・期限切れ・使用済みのいずれでも
 * 同じメッセージになる（API 側で `INVALID_CREDENTIALS` に一本化済み）。
 * 出し分けると、トークンの有効性を調べる手段になる。
 */
export function PasswordResetConfirm({ token }: { readonly token: string }) {
  if (token === '') {
    return (
      <main
        style={{
          maxWidth: 'var(--tf-size-form)',
          margin: '0 auto',
          padding: 'var(--tf-space-8) var(--tf-space-4)',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--tf-space-4)' }}>とりふね</h1>
        <Alert tone="danger">
          再設定用のリンクが正しくありません。メールのリンクをもう一度開くか、
          <a href="/password-reset">再設定をやり直して</a>ください。
        </Alert>
      </main>
    );
  }

  return (
    <AuthForm
      title="新しいパスワードの設定"
      description="新しいパスワードを入力してください。設定すると、このアカウントのログイン中のセッションはすべて終了します。"
      submitLabel="パスワードを設定する"
      endpoint="/api/v1/auth/password-reset/confirm"
      redirectTo="/login"
      extraValues={{ token }}
      fields={[
        {
          name: 'newPassword',
          label: '新しいパスワード',
          type: 'password',
          autoComplete: 'new-password',
        },
      ]}
    />
  );
}
