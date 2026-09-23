/**
 * 偽の Instagram Graph API の応答例（038-sns-instagram 設計 §10.9 #69）。
 *
 * **応答の形の唯一の定義。** 単体テスト（偽の `fetch` が返す `Response`）と、
 * ループバックのサーバ（`node:http` が書き出す応答）が同じものを使う。片方だけを書き換えられない。
 *
 * 形は Meta の公開ドキュメントの例に従う（実機で確かめたものではない。設計 §11 #12）。
 * **`plugins/sns-instagram` を import しない。** 応答の形だけを持つ。
 */

/* -------------------------------------------------------------------------- */
/* 値（どれも架空）                                                             */
/* -------------------------------------------------------------------------- */

/** 資格情報の `igUserId`。 */
export const IG_USER_ID = '17841400000000001';

/** 資格情報の `accessToken`。 */
export const ACCESS_TOKEN = 'IGAAtorifuneTestAccessToken0001';

/** 延長（R6）が返す新しいトークン。 */
export const REFRESHED_ACCESS_TOKEN = 'IGAAtorifuneTestRefreshedToken0002';

/** 延長（R6）が返す `expires_in`（秒。約 60 日）。 */
export const REFRESHED_EXPIRES_IN = 5_183_944;

/** 単体の container ID（R1 の応答）。 */
export const CONTAINER_ID = '17900000000000001';

/** carousel の親 container ID（R2 の応答）。 */
export const CAROUSEL_CONTAINER_ID = '17900000000000999';

/** carousel の子 container ID。添字ごとに別の値。 */
export function childContainerId(index: number): string {
  return `1790000000000${String(100 + index).padStart(4, '0')}`;
}

/** 公開した投稿の media ID（R4 の応答）。 */
export const MEDIA_ID = '17950000000000001';

/** 公開した投稿の URL（R5 の応答）。 */
export const PERMALINK = 'https://www.instagram.com/p/AbCdEf012/';

/* -------------------------------------------------------------------------- */
/* 応答例                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 1 つの応答。`body` が文字列ならそのまま、それ以外は JSON にして返す。
 */
export interface GraphResponseExample {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** container の状態（R3 の `status_code`）。 */
export type ContainerStatusCode = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

/** Graph API のエラーの本体に入れる項目（公開ドキュメントの形）。 */
export interface GraphErrorExample {
  readonly status?: number;
  readonly code?: unknown;
  readonly subcode?: unknown;
  readonly isTransient?: boolean;
  readonly message?: string;
  readonly type?: string;
  readonly errorUserTitle?: string;
  readonly errorUserMsg?: string;
  readonly fbtraceId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** R1 / R2：container を作った。 */
export function containerCreated(id: string): GraphResponseExample {
  return { status: 200, body: { id } };
}

/** R3：container の状態。 */
export function containerStatus(
  statusCode: ContainerStatusCode | string,
  id: string = CONTAINER_ID,
): GraphResponseExample {
  return { status: 200, body: { status_code: statusCode, id } };
}

/** R4：公開した。 */
export function mediaPublished(id: string = MEDIA_ID): GraphResponseExample {
  return { status: 200, body: { id } };
}

/** R5：投稿の URL。 */
export function permalinkOf(
  permalink: unknown = PERMALINK,
  id: string = MEDIA_ID,
): GraphResponseExample {
  return { status: 200, body: { permalink, id } };
}

/** `tokenRefreshed` の `expires_in` を本体に入れないことを表す値。 */
export const OMIT_EXPIRES_IN: unique symbol = Symbol('omit-expires-in');

/** R6：延長した。`expiresIn` に `OMIT_EXPIRES_IN` を渡すと `expires_in` の無い本体になる。 */
export function tokenRefreshed(
  accessToken: unknown = REFRESHED_ACCESS_TOKEN,
  expiresIn: unknown = REFRESHED_EXPIRES_IN,
): GraphResponseExample {
  const body: Record<string, unknown> = { access_token: accessToken, token_type: 'bearer' };
  if (expiresIn !== OMIT_EXPIRES_IN) {
    body['expires_in'] = expiresIn;
  }
  return { status: 200, body };
}

/** Graph API のエラー（`{ "error": { … } }`）。既定は HTTP 400。 */
export function graphError(example: GraphErrorExample = {}): GraphResponseExample {
  const error: Record<string, unknown> = {
    message: example.message ?? 'An error occurred.',
    type: example.type ?? 'OAuthException',
  };
  if (example.code !== undefined) {
    error['code'] = example.code;
  }
  if (example.subcode !== undefined) {
    error['error_subcode'] = example.subcode;
  }
  if (example.isTransient !== undefined) {
    error['is_transient'] = example.isTransient;
  }
  if (example.errorUserTitle !== undefined) {
    error['error_user_title'] = example.errorUserTitle;
  }
  if (example.errorUserMsg !== undefined) {
    error['error_user_msg'] = example.errorUserMsg;
  }
  if (example.fbtraceId !== undefined) {
    error['fbtrace_id'] = example.fbtraceId;
  }
  return {
    status: example.status ?? 400,
    body: { error },
    ...(example.headers === undefined ? {} : { headers: example.headers }),
  };
}

/** 本体が HTML（JSON でない）。 */
export function htmlPage(status = 200): GraphResponseExample {
  return {
    status,
    body: '<!DOCTYPE html><html><body>Sorry, something went wrong.</body></html>',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  };
}

/** 転送（3xx）。**追わない**（設計 §6.2）。 */
export function redirectTo(
  location = 'https://example.test/elsewhere',
  status = 302,
): GraphResponseExample {
  return { status, body: '', headers: { location } };
}

/* -------------------------------------------------------------------------- */
/* 書き出し                                                                     */
/* -------------------------------------------------------------------------- */

/** 応答例を HTTP の 3 要素にする。**偽の `fetch` もループバックのサーバもこれを通す。** */
export function serializeExample(example: GraphResponseExample): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const isText = typeof example.body === 'string';
  return {
    status: example.status,
    headers: {
      ...(isText ? {} : { 'content-type': 'application/json; charset=UTF-8' }),
      ...example.headers,
    },
    body: isText ? (example.body as string) : JSON.stringify(example.body),
  };
}

/** 偽の `fetch` が返す `Response`。 */
export function toResponse(example: GraphResponseExample): Response {
  const { status, headers, body } = serializeExample(example);
  // 1xx / 204 / 205 / 304 は本体を持てない。
  const bodyless = status === 204 || status === 205 || status === 304;
  return new Response(bodyless ? null : body, { status, headers });
}
