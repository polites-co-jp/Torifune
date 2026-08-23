import type { z } from 'zod';
import {
  requirePermission,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { buildAuthorizationContext } from '@/application/authorization/context';
import type { PermissionName } from '@/domain/permission';
import { ConflictError, NotFoundError } from '@/domain/repository';
import { authorizationErrorResponse } from './authorize';
import { CSRF_COOKIE, readCookie, requestInfoOf, SESSION_COOKIE } from './cookies';
import { corsHeaders } from './cors';
import { verifyCsrf } from './csrf';
import { errorResponse } from './errors';
import { UnknownSortFieldError } from './query';
import { registerEndpoint, type EndpointSpec } from './registry';
import { createRateLimiter, type RateLimitPolicy } from './rate-limit';
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
  readonly query?: TQuerySchema;
  /** 公開 API 仕様に載せるか。内部エンドポイントは false。 */
  readonly documented?: boolean;
  readonly rateLimit?: RateLimitPolicy;
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

  const limiter =
    definition.rateLimit === undefined ? null : createRateLimiter(definition.rateLimit);

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

      // 状態を変えるメソッドは CSRF を検証する（04_認証設計.md §12）。
      let rawBody: unknown;
      if (!SAFE_METHODS.has(definition.method)) {
        rawBody = await request
          .clone()
          .json()
          .catch(() => undefined);

        const bodyToken =
          typeof rawBody === 'object' && rawBody !== null && 'csrfToken' in rawBody
            ? String((rawBody as Record<string, unknown>)['csrfToken'])
            : undefined;

        if (!verifyCsrf(request, { cookieToken: readCookie(request, CSRF_COOKIE), bodyToken })) {
          return errorResponse('CSRF_FAILED', undefined, cors);
        }
      }

      const context = await buildAuthorizationContext(
        readCookie(request, SESSION_COOKIE),
        requestInfoOf(request),
      );

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
      if (error instanceof NotFoundError) {
        return errorResponse('NOT_FOUND', undefined, cors);
      }
      if (error instanceof ConflictError) {
        return errorResponse('CONFLICT', undefined, cors);
      }

      // 想定外の例外。**内容を応答へ出さない**（05_API設計.md §11）。
      // 原因の追跡はサーバー側のログで行う。
      console.error(
        JSON.stringify({
          message: 'unhandled error in route',
          operationId: definition.operationId,
        }),
      );
      return errorResponse('INTERNAL_ERROR', undefined, cors);
    }
  };
}
