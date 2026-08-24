import { messageFor, type ClientErrorCode } from './error-message';

/**
 * 共通 API Client（07_開発者向けガイド.md §32）。
 *
 * 各画面で個別に fetch を書くと、CSRF トークンの付け忘れや
 * エラー処理の抜けが必ず起きる。**入口を1つにする。**
 */

export interface ApiFailure {
  readonly code: ClientErrorCode | string;
  readonly message: string;
  readonly status: number;
  readonly details?: Record<string, readonly string[]>;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly meta?: unknown }
  | { readonly ok: false; readonly error: ApiFailure };

let csrfToken: string | null = null;

/** CSRF トークンを取得する。取得済みなら使い回す。 */
async function ensureCsrfToken(): Promise<string | null> {
  if (csrfToken !== null) {
    return csrfToken;
  }
  try {
    const response = await fetch('/api/v1/auth/csrf');
    const body = (await response.json()) as { data?: { csrfToken?: string } };
    csrfToken = body.data?.csrfToken ?? null;
  } catch {
    csrfToken = null;
  }
  return csrfToken;
}

/** CSRF トークンを捨てる。403 のあと取り直すため。 */
export function invalidateCsrfToken(): void {
  csrfToken = null;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  let body: string | undefined;

  if (!SAFE_METHODS.has(method)) {
    const token = await ensureCsrfToken();
    if (token !== null) {
      headers['X-CSRF-Token'] = token;
    }
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ ...(options.body as object), csrfToken: token ?? '' });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return {
      ok: false,
      error: { code: 'NETWORK_ERROR', message: messageFor('NETWORK_ERROR'), status: 0 },
    };
  }

  return interpret<T>(response);
}

/** 応答の解釈。JSON でもファイル送信でも同じ扱いにする。 */
async function interpret<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (response.ok) {
    const parsed = payload as { data?: T; meta?: unknown };
    return { ok: true, data: parsed?.data as T, meta: parsed?.meta };
  }

  const parsed = payload as {
    error?: { code?: string; details?: Record<string, readonly string[]> };
  };
  const code = parsed?.error?.code;

  if (response.status === 403 && code === 'CSRF_FAILED') {
    // トークンが古い。次の呼び出しで取り直す。
    invalidateCsrfToken();
  }

  return {
    ok: false,
    error: {
      code: code ?? 'UNEXPECTED',
      // **サーバーの message ではなく、画面側の文言を使う。**
      // 内部事情が混ざった文言が出るのを防ぐ。
      message: messageFor(code),
      status: response.status,
      ...(parsed?.error?.details === undefined ? {} : { details: parsed.error.details }),
    },
  };
}

/**
 * ファイルを送る。
 *
 * JSON では送れないため `apiRequest` と別入口にするが、
 * **CSRF とエラー処理は同じ扱いにする。** 別扱いにすると、
 * こちらだけ抜けが起きる。
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  const token = await ensureCsrfToken();
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers['X-CSRF-Token'] = token;
  }

  let response: Response;
  try {
    // Content-Type は指定しない。boundary を fetch に決めさせる。
    response = await fetch(path, { method: 'POST', headers, body: form });
  } catch {
    return {
      ok: false,
      error: { code: 'NETWORK_ERROR', message: messageFor('NETWORK_ERROR'), status: 0 },
    };
  }

  return interpret<T>(response);
}

/** 401 のとき、ログイン画面へ送る。 */
export function redirectToLogin(): void {
  if (typeof window !== 'undefined') {
    window.location.assign('/login');
  }
}
