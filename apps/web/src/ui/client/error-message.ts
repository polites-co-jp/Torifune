import type { ErrorCode } from '@/api/errors';

/**
 * エラーコード → 画面へ出す文言（06_画面設計.md §34）。
 *
 * **内部例外やスタックトレースを画面へ出さない。**
 * サーバーが返した `message` をそのまま出す手もあるが、
 * 表示文言を画面側で持てば、将来の国際化もここだけで済む。
 */

/** サーバーのエラーコードに加え、クライアント側で起きうるものを足す。 */
export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED';

const MESSAGES: Record<ClientErrorCode, string> = {
  BAD_REQUEST: 'リクエストの形式が正しくありません。',
  VALIDATION_ERROR: '入力内容を確認してください。',
  CSRF_FAILED: 'リクエストを検証できませんでした。画面を再読み込みしてください。',
  INVALID_CREDENTIALS: 'ログインIDまたはパスワードが正しくありません。',
  TOO_MANY_ATTEMPTS: '試行回数が多すぎます。しばらく待ってからやり直してください。',
  UNAUTHENTICATED: 'ログインしてください。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '見つかりませんでした。',
  CONFLICT: 'すでに使用されています。',
  INTERNAL_ERROR: 'エラーが発生しました。時間をおいてやり直してください。',
  NETWORK_ERROR: '通信に失敗しました。接続を確認してください。',
  UNEXPECTED: 'エラーが発生しました。',
};

export function messageFor(code: string | undefined): string {
  if (code !== undefined && code in MESSAGES) {
    return MESSAGES[code as ClientErrorCode];
  }
  // 未知のコードでも、内部の値をそのまま出さない。
  return MESSAGES.UNEXPECTED;
}

/** 定義済みのコード一覧。テストで網羅を確認する。 */
export const ERROR_CODES = Object.keys(MESSAGES) as ClientErrorCode[];
