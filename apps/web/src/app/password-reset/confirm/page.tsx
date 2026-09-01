import { PasswordResetConfirm } from '@/ui/password-reset-confirm';

/**
 * パスワード再設定の入力画面。
 *
 * トークンはここ（サーバー側）で読む。`useSearchParams()` を使うと
 * Next.js がクライアント描画へ退避し、その shell に CSP の nonce が入らないため、
 * スクリプトがブロックされて操作できない画面になる（022-hardening）。
 */
export default async function PasswordResetConfirmPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const token = (await searchParams)['token'];

  // 同じ名前で複数回渡された場合は不正な要求として扱う。
  return <PasswordResetConfirm token={typeof token === 'string' ? token : ''} />;
}
