import { AuthForm } from '@/ui/auth-form';

export default function PasswordResetPage() {
  return (
    <AuthForm
      title="パスワードの再設定"
      submitLabel="再設定用のリンクを送る"
      endpoint="/api/v1/auth/password-reset/request"
      redirectTo="/login"
      fields={[{ name: 'email', label: 'メールアドレス', type: 'email', autoComplete: 'email' }]}
    />
  );
}
