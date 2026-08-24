/**
 * API のエラー応答（05_API設計.md §11）。
 *
 * 形を1箇所に集める。各ルートで組み立てると、いつか内部例外がそのまま出る。
 * `004-api-foundation` でここを拡張する。
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'CSRF_FAILED'
  | 'INVALID_CREDENTIALS'
  | 'TOO_MANY_ATTEMPTS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  CSRF_FAILED: 403,
  INVALID_CREDENTIALS: 401,
  TOO_MANY_ATTEMPTS: 429,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

const MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  BAD_REQUEST: 'リクエストの形式が正しくありません。',
  VALIDATION_ERROR: '入力内容を確認してください。',
  CSRF_FAILED: 'リクエストを検証できませんでした。画面を再読み込みしてください。',
  INVALID_CREDENTIALS: 'ログインIDまたはパスワードが正しくありません。',
  TOO_MANY_ATTEMPTS: '試行回数が多すぎます。しばらく待ってからやり直してください。',
  UNAUTHENTICATED: 'ログインしてください。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '見つかりませんでした。',
  CONFLICT: 'すでに使用されています。',
  INTERNAL_ERROR: 'エラーが発生しました。',
};

export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Record<string, readonly string[]>;
  };
}

/**
 * エラー応答を作る。
 *
 * **内部例外の詳細・Stack Trace・SQL をここへ渡さない**（05_API設計.md §11）。
 * `details` はフィールド単位の入力エラーのためだけに使う。
 */
export function errorResponse(
  code: ErrorCode,
  details?: Record<string, readonly string[]>,
  extraHeaders?: Record<string, string>,
): Response {
  const body: ErrorBody = {
    error: {
      code,
      message: MESSAGE_BY_CODE[code],
      ...(details === undefined ? {} : { details }),
    },
  };

  return Response.json(body, {
    status: STATUS_BY_CODE[code],
    headers: extraHeaders,
  });
}

/** リクエストボディを JSON として読む。壊れていても例外を投げない。 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** ボディから文字列項目を取り出す。型が違えば undefined。 */
export function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}
