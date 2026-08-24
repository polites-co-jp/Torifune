/**
 * 成功応答の組み立て（05_API設計.md §10）。
 *
 * **形を1箇所で決める。** 各ルートで組み立てると、いつか形が揺れる。
 */

export interface PageMeta {
  readonly page: number;
  readonly perPage: number;
  /** そのページの件数ではなく、条件に合う全件数。 */
  readonly total: number;
}

export interface ResponseInit2 {
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

/** 単体の成功応答。 */
export function dataResponse<T>(data: T, init?: ResponseInit2): Response {
  return Response.json({ data }, { status: init?.status ?? 200, headers: init?.headers });
}

/** 一覧の成功応答。 */
export function pageResponse<T>(
  items: readonly T[],
  meta: PageMeta,
  init?: ResponseInit2,
): Response {
  return Response.json(
    { data: items, meta },
    { status: init?.status ?? 200, headers: init?.headers },
  );
}

/** 作成成功。 */
export function createdResponse<T>(data: T, init?: ResponseInit2): Response {
  return Response.json({ data }, { status: 201, headers: init?.headers });
}

/** 本文なしの成功。 */
export function noContentResponse(init?: ResponseInit2): Response {
  return new Response(null, { status: 204, headers: init?.headers });
}
