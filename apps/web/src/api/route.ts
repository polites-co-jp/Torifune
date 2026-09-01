import type { z } from 'zod';
import {
  requirePermission,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import {
  buildApiTokenContext,
  buildAuthorizationContext,
} from '@/application/authorization/context';
import { bearerTokenOf } from '@/domain/api-token';
import type { PermissionName } from '@/domain/permission';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/repository';
import { log } from '@/infrastructure/logging';
import { authorizationErrorResponse } from './authorize';
import { CSRF_COOKIE, readCookie, requestInfoOf, SESSION_COOKIE } from './cookies';
import { corsHeaders } from './cors';
import { verifyCsrf } from './csrf';
import { errorResponse } from './errors';
import { UnknownSortFieldError } from './query';
import { registerEndpoint, type EndpointSpec } from './registry';
import { createRateLimiter, DEFAULT_RATE_LIMIT, type RateLimitPolicy } from './rate-limit';
import { validate } from './validation';

/**
 * ルートを組み立てる共通ヘルパ。
 *
 * 認証・認可・CSRF・検証・応答・エラー変換を1箇所に集める。
 * **各ルートで手順を並べると、いつか1つ抜ける。**
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RouteContext<TBody, TQuery> {
  readonly request: Request;
  readonly context: AuthorizationContext;
  readonly body: TBody;
  readonly query: TQuery;
  readonly params: Record<string, string>;
}

export interface RouteDefinition<TBodySchema extends z.ZodType, TQuerySchema extends z.ZodType> {
  /** OpenAPI の operationId。エンドポイントの一意な名前。 */
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly summary: string;
  /** null なら認可しない。**理由を `reason` に書く。** */
  readonly permission: PermissionName | null;
  readonly reason?: string;
  readonly body?: TBodySchema;
  /**
   * ボディの読み方。既定は JSON。
   *
   * `raw` はハンドラが自分で読む（ファイルのアップロードなど）。
   * 大きなボディを JSON として読もうとすると、その分だけ無駄に確保する。
   * CSRF トークンは `x-csrf-token` ヘッダで送る。
   */
  readonly bodyKind?: 'json' | 'raw';
  readonly query?: TQuerySchema;
  /** 公開 API 仕様に載せるか。内部エンドポイントは false。 */
  readonly documented?: boolean;
  /**
   * セッション認証だけを許す（API Token では呼べない）。
   *
   * Token から Token を作れると、Scope を絞った Token より広い Token を
   * 発行できてしまう（021-api-token 設計 §5）。
   */
  readonly sessionOnly?: boolean;
  /**
   * Rate Limit。
   *
   * **省略すると既定（`DEFAULT_RATE_LIMIT`）がかかる。**
   * ルートごとに書かせると必ず抜ける（`05_API設計.md` §36 が挙げる
   * 「大量データ取得」は、実際に一覧APIで抜けていた）。
   *
   * 厳しくしたいものは上書きする。外すときだけ `'none'` を書き、理由を添える。
   */
  readonly rateLimit?: RateLimitPolicy | 'none';
  readonly handler: (
    ctx: RouteContext<z.output<TBodySchema>, z.output<TQuerySchema>>,
  ) => Promise<Response>;
}

export class RouteDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteDefinitionError';
  }
}

/** Rate Limit のキー。IP を使う。 */
function rateLimitKey(request: Request, operationId: string): string {
  const info = requestInfoOf(request);
  return `${operationId}:${info.ipAddress ?? 'unknown'}`;
}

export function defineRoute<TBodySchema extends z.ZodType, TQuerySchema extends z.ZodType>(
  definition: RouteDefinition<TBodySchema, TQuerySchema>,
): (request: Request, args?: { params?: Promise<Record<string, string>> }) => Promise<Response> {
  if (definition.permission === null && (definition.reason ?? '') === '') {
    // 「認可が要らない」は必ず説明を伴わせる。説明を書けないなら、たいてい認可が要る。
    throw new RouteDefinitionError(
      `${definition.operationId}: permission が null のときは reason が必須`,
    );
  }

  const spec: EndpointSpec = {
    operationId: definition.operationId,
    method: definition.method,
    path: definition.path,
    summary: definition.summary,
    permission: definition.permission,
    documented: definition.documented ?? true,
    bodySchema: definition.body,
    querySchema: definition.query,
  };
  registerEndpoint(spec);

  // 省略したら既定がかかる。**書かなければ無制限、にしない。**
  const limiter =
    definition.rateLimit === 'none'
      ? null
      : createRateLimiter(definition.rateLimit ?? DEFAULT_RATE_LIMIT);

  return async function handle(
    request: Request,
    args?: { params?: Promise<Record<string, string>> },
  ): Promise<Response> {
    const cors = corsHeaders(request);

    try {
      if (limiter !== null) {
        const verdict = limiter.check(rateLimitKey(request, definition.operationId), Date.now());
        if (!verdict.allowed) {
          return errorResponse('TOO_MANY_ATTEMPTS', undefined, {
            ...cors,
            'Retry-After': String(verdict.retryAfterSeconds),
          });
        }
      }

      // **Bearer が付いていれば Bearer で認証する。**
      // Cookie と両方あるときに「どちらでも通る」にすると、
      // CSRF 検証を Bearer で迂回できてしまう（設計 §2.5）。
      const bearer = bearerTokenOf(request.headers.get('authorization'));

      // 状態を変えるメソッドは CSRF を検証する（04_認証設計.md §12）。
      //
      // **Bearer 認証では検証しない。** CSRF は「ブラウザが Cookie を自動送信すること」
      // への対策で、`Authorization` ヘッダは自動送信されない。
      // 検証したままにすると、API クライアントが更新系を一切呼べない。
      let rawBody: unknown;
      if (!SAFE_METHODS.has(definition.method)) {
        if ((definition.bodyKind ?? 'json') === 'json') {
          rawBody = await request
            .clone()
            .json()
            .catch(() => undefined);
        }

        if (bearer === null) {
          const bodyToken =
            typeof rawBody === 'object' && rawBody !== null && 'csrfToken' in rawBody
              ? String((rawBody as Record<string, unknown>)['csrfToken'])
              : undefined;

          if (!verifyCsrf(request, { cookieToken: readCookie(request, CSRF_COOKIE), bodyToken })) {
            return errorResponse('CSRF_FAILED', undefined, cors);
          }
        }
      }

      if (bearer !== null && definition.sessionOnly === true) {
        // Token から Token を作れると、Scope を絞った Token より広い Token を
        // 発行できてしまい、Scope の意味が無くなる（設計 §5）。
        return errorResponse('UNAUTHENTICATED', undefined, cors);
      }

      const context =
        bearer === null
          ? await buildAuthorizationContext(
              readCookie(request, SESSION_COOKIE),
              requestInfoOf(request),
            )
          : await buildApiTokenContext(bearer, requestInfoOf(request));

      if (definition.permission !== null) {
        requirePermission(context, definition.permission);
      }

      let body: unknown;
      if (definition.body !== undefined) {
        const result = validate(definition.body, rawBody ?? {});
        if (!result.ok) {
          return errorResponse('VALIDATION_ERROR', result.details, cors);
        }
        body = result.value;
      }

      let query: unknown;
      if (definition.query !== undefined) {
        const raw: Record<string, string> = {};
        for (const [key, value] of new URL(request.url).searchParams) {
          raw[key] = value;
        }
        const result = validate(definition.query, raw);
        if (!result.ok) {
          return errorResponse('VALIDATION_ERROR', result.details, cors);
        }
        query = result.value;
      }

      const params = (await args?.params) ?? {};

      const response = await definition.handler({
        request,
        context,
        body: body as z.output<TBodySchema>,
        query: query as z.output<TQuerySchema>,
        params,
      });

      for (const [key, value] of Object.entries(cors)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (error) {
      const authError = authorizationErrorResponse(error);
      if (authError !== null) {
        return authError;
      }
      if (error instanceof UnknownSortFieldError) {
        return errorResponse('VALIDATION_ERROR', { sort: ['並び替えに使えません。'] }, cors);
      }
      if (error instanceof ValidationError) {
        return errorResponse('VALIDATION_ERROR', { [error.field]: [error.detail] }, cors);
      }
      if (error instanceof NotFoundError) {
        return errorResponse('NOT_FOUND', undefined, cors);
      }
      if (error instanceof ConflictError) {
        return errorResponse('CONFLICT', undefined, cors);
      }

      // 想定外の例外。**内容を応答へ出さない**（05_API設計.md §11）。
      // 原因の追跡はサーバー側のログで行う。
      log.error('unhandled error in route', {
        operationId: definition.operationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('INTERNAL_ERROR', undefined, cors);
    }
  };
}
