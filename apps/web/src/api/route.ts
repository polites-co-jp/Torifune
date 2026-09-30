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
import { JobBusyError } from '@/domain/jobs/job';
import type { PermissionName } from '@/domain/permission';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/repository';
import { unusableTextDetailsOf } from '@/domain/text';
import { log } from '@/infrastructure/logging';
import { redactSecrets } from '@/infrastructure/secret-text';
import { authorizationErrorResponse } from './authorize';
import { CSRF_COOKIE, readCookie, requestInfoOf, SESSION_COOKIE } from './cookies';
import { corsHeaders } from './cors';
import { verifyCsrf } from './csrf';
import { assertValidDeprecation, deprecationHeaders, type DeprecationNotice } from './deprecation';
import { errorResponse } from './errors';
import { UnknownSortFieldError } from './query';
import { registerEndpoint, type AdditionalResponse, type EndpointSpec } from './registry';
import { createRateLimiter, DEFAULT_RATE_LIMIT, type RateLimitPolicy } from './rate-limit';
import { validate } from './validation';

/**
 * ルートを組み立てる共通ヘルパ。
 *
 * 認証・認可・CSRF・検証・応答・エラー変換を1箇所に集める。
 * **各ルートで手順を並べると、いつか1つ抜ける。**
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 使えない文字の 422 の `details` に入れるキーの上限（046-input-500-nul-and-ranges 設計 §6.2 の規則 3）。 */
const UNUSABLE_TEXT_DETAIL_KEYS_MAX = 50;

/**
 * 想定外の例外をログへ載せるときの理由（029-scheduled-jobs 設計 §6.1.7）。
 *
 * **例外のメッセージは自由文で、接続文字列を含みうる。** Database Provider を差し替えた Plugin の
 * 例外は標準 Provider の秘匿を通らないし、`logging.ts` の `maskSecrets` はキー名で落とす仕組みなので
 * `reason` の中身には効かない。`job_runs.error` に伏せて書いた値が、
 * 同じ例外からログへ素通りするのでは秘匿になっていない。
 */
function logReasonOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

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
  /**
   * 成功時の応答スキーマ（05_API設計.md §40）。
   *
   * 外側まで含めて書く。`api/schemas/envelope.ts` の
   * `dataEnvelope` / `pageEnvelope` / `listEnvelope` で包む。
   *
   * **任意にしてある。** 全エンドポイントへ一度に付けると差分が大きくなりすぎるので、
   * 主要なものから付けている。未宣言の一覧は E2E で固定してあり、
   * 新しいエンドポイントを未宣言のまま足すとテストが落ちる。
   */
  readonly response?: z.ZodType;
  /** 成功時のステータス。既定は 200。作成は 201、本文なしは 204。 */
  readonly successStatus?: 200 | 201 | 204;
  /**
   * 非推奨の告知（05_API設計.md §41）。
   *
   * 書くと OpenAPI に `deprecated: true` が出て、
   * 応答に `Deprecation` / `Sunset` ヘッダが付く（`api/deprecation.ts`）。
   */
  readonly deprecated?: DeprecationNotice;
  /**
   * 成功・共通のエラー以外に、この操作が返しうる応答（05_API設計.md §40）。
   *
   * OpenAPI の `responses` に足される。200 の本文は `response` と同じ形、404 / 409 はエラーの形。
   * 書かなければ `responses` は変わらない（042-social-api-input-fixes 設計 §6.4）。
   */
  readonly additionalResponses?: readonly AdditionalResponse[];
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
   * CSRF 検証を行わない理由。
   *
   * **書いた時点で例外扱いになる。** 空にはできない。
   *
   * CSRF は「ブラウザが Cookie を自動送信すること」への対策であり、
   * セッションに紐づく特権操作を守るためのもの。
   * **他所のサイトから叩かれることが前提の口**（計測ビーコンなど）では、
   * 検証しても守るものが無く、正しい要求を落とすだけになる。
   *
   * 外すときは「セッションに紐づく操作を一切していない」ことを確かめること。
   */
  readonly csrfExemptReason?: string;
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

/**
 * 本文とクエリの保存できない文字（NUL・対になっていないサロゲート）の誤りをまとめる
 * （046-input-500-nul-and-ranges 設計 §6.2）。本文 → クエリの順。同じキーは文言を重ねない。
 *
 * **キーは送った側が決める**（`constructor`・`__proto__` も来る）ので、オブジェクトではなく `Map` に積み、
 * `Object.fromEntries` で自分のプロパティとして返す（046 検証の指摘 M1）。
 *
 * 返すキーは**先頭の `UNUSABLE_TEXT_DETAIL_KEYS_MAX` 個まで**（設計 §6.2 の規則 3 の追記。046 検証の指摘 security L2）。
 * 項目の数だけ文言を返すと、認証の要らない口へ小さな項目を並べるだけで応答を何倍にも膨らませられる。
 * 直せば残りは次の要求で返る（Zod を走らせないのと同じ扱い）。
 */
function mergeUnusableTextDetails(
  ...parts: readonly Record<string, string[]>[]
): Record<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const part of parts) {
    for (const [key, messages] of Object.entries(part)) {
      const current = merged.get(key);
      if (current === undefined && merged.size >= UNUSABLE_TEXT_DETAIL_KEYS_MAX) {
        continue;
      }
      const known = current ?? [];
      merged.set(key, [...known, ...messages.filter((message) => !known.includes(message))]);
    }
  }
  return Object.fromEntries(merged);
}

/** Rate Limit のキー。IP を使う。 */
function rateLimitKey(request: Request, operationId: string): string {
  const info = requestInfoOf(request);
  return `${operationId}:${info.ipAddress ?? 'unknown'}`;
}

/**
 * `additionalResponses` の定義の誤りを起動時に見つける（042-social-api-input-fixes 設計 §6.4）。
 *
 * 書いたつもりの宣言が成功の応答を上書きしたり、本文の形の無い 200 を出したりしないようにする。
 * 認可のある操作の 401 は生成器が出すので、書くと description が上書きされてどちらが正か分からなくなる
 * （043-api-input-fixes-rest 設計 §6.4）。
 */
function assertValidAdditionalResponses(definition: {
  readonly operationId: string;
  readonly permission: PermissionName | null;
  readonly successStatus?: 200 | 201 | 204;
  readonly response?: z.ZodType;
  readonly additionalResponses?: readonly AdditionalResponse[];
}): void {
  const successStatus = definition.successStatus ?? 200;
  const seen = new Set<number>();

  for (const additional of definition.additionalResponses ?? []) {
    if (additional.status === successStatus) {
      throw new RouteDefinitionError(
        `${definition.operationId}: additionalResponses に成功と同じ ${additional.status} は書けない`,
      );
    }
    if (seen.has(additional.status)) {
      throw new RouteDefinitionError(
        `${definition.operationId}: additionalResponses の ${additional.status} が重複している`,
      );
    }
    if (additional.status === 401 && definition.permission !== null) {
      throw new RouteDefinitionError(
        `${definition.operationId}: 認可のある操作の 401 は生成器が出すので additionalResponses に書けない`,
      );
    }
    if (additional.status === 200 && definition.response === undefined) {
      throw new RouteDefinitionError(
        `${definition.operationId}: additionalResponses の 200 には response が要る`,
      );
    }
    seen.add(additional.status);
  }
}

export function defineRoute<TBodySchema extends z.ZodType, TQuerySchema extends z.ZodType>(
  definition: RouteDefinition<TBodySchema, TQuerySchema>,
): (request: Request, args?: { params?: Promise<Record<string, string>> }) => Promise<Response> {
  if (definition.csrfExemptReason !== undefined && definition.csrfExemptReason.trim() === '') {
    // 「理由を書けないなら外さない」を構造で守る。
    throw new RouteDefinitionError(`${definition.operationId}: csrfExemptReason は空にできない`);
  }

  if (definition.permission === null && (definition.reason ?? '') === '') {
    // 「認可が要らない」は必ず説明を伴わせる。説明を書けないなら、たいてい認可が要る。
    throw new RouteDefinitionError(
      `${definition.operationId}: permission が null のときは reason が必須`,
    );
  }

  if (definition.deprecated !== undefined) {
    // 告知として成立していない `deprecated` は、書いたつもりで告知できていない状態。
    assertValidDeprecation(definition.operationId, definition.deprecated);
  }

  if (definition.successStatus === 204 && definition.response !== undefined) {
    throw new RouteDefinitionError(
      `${definition.operationId}: 204 は本文を返さないので response を書けない`,
    );
  }

  assertValidAdditionalResponses(definition);

  const spec: EndpointSpec = {
    operationId: definition.operationId,
    method: definition.method,
    path: definition.path,
    summary: definition.summary,
    permission: definition.permission,
    documented: definition.documented ?? true,
    sessionOnly: definition.sessionOnly ?? false,
    bodySchema: definition.body,
    querySchema: definition.query,
    responseSchema: definition.response,
    successStatus: definition.successStatus,
    deprecated: definition.deprecated,
    additionalResponses: definition.additionalResponses,
  };
  registerEndpoint(spec);

  // 非推奨なら**すべての応答**へ付ける。成功時だけにすると、
  // 認証に失敗し続けているクライアントには最後まで届かない。
  const deprecation =
    definition.deprecated === undefined ? {} : deprecationHeaders(definition.deprecated);

  // 省略したら既定がかかる。**書かなければ無制限、にしない。**
  const limiter =
    definition.rateLimit === 'none'
      ? null
      : createRateLimiter(definition.rateLimit ?? DEFAULT_RATE_LIMIT);

  return async function handle(
    request: Request,
    args?: { params?: Promise<Record<string, string>> },
  ): Promise<Response> {
    // 以降の応答すべてに付ける共通ヘッダ。CORS と非推奨の告知。
    const cors = { ...corsHeaders(request), ...deprecation };

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

        // csrfExemptReason が書かれている口は検証しない（理由は定義側に書く）。
        if (bearer === null && definition.csrfExemptReason === undefined) {
          const sentToken =
            typeof rawBody === 'object' && rawBody !== null && Object.hasOwn(rawBody, 'csrfToken')
              ? (rawBody as Record<string, unknown>)['csrfToken']
              : undefined;

          // **本文の `csrfToken` は文字列のときだけ使う。文字列でなければ CSRF の失敗**（046 検証の指摘 N1）。
          // 文字列にしようとすると、`{"toString":1}` で `TypeError`、1 万段の配列で `RangeError` になって
          // 認証の要らない口まで 500 を返す。`["<トークン>"]` のような値を文字列にして一致させることもしない。
          if (sentToken !== undefined && typeof sentToken !== 'string') {
            return errorResponse('CSRF_FAILED', undefined, cors);
          }

          if (
            !verifyCsrf(request, {
              cookieToken: readCookie(request, CSRF_COOKIE),
              bodyToken: sentToken,
            })
          ) {
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

      // クエリは宣言したルートだけ集める。宣言していないルート（`/auth/callback`）の値は入力として扱わない。
      // 同じ名前が並べば後のものを使う。`Object.fromEntries` で作るのは、`?__proto__=` のような名前も
      // 代入で原型を差し替えずに自分のプロパティとして残し、検査から漏らさないため（046 検証の指摘 M1）。
      const rawQuery: Record<string, string> | undefined =
        definition.query !== undefined
          ? Object.fromEntries(new URL(request.url).searchParams)
          : undefined;

      // **保存できない文字は認可の後、Zod の前で断る**（046-input-500-nul-and-ranges 設計 §6.2）。
      // NUL は PostgreSQL が保存できず、片割れは黙って U+FFFD に化けるか jsonb で断られる。
      // 認証の要らない口（ログイン・再設定・セットアップ・計測）も UseCase を通らないのでここで断る。
      // 本文は置き換えずにそのまま Zod へ渡す。送った値は応答にもログにも載せない。
      const unusableText = mergeUnusableTextDetails(
        definition.body !== undefined && (definition.bodyKind ?? 'json') === 'json'
          ? unusableTextDetailsOf(rawBody ?? {})
          : {},
        rawQuery !== undefined ? unusableTextDetailsOf(rawQuery) : {},
      );
      if (Object.keys(unusableText).length > 0) {
        return errorResponse('VALIDATION_ERROR', unusableText, cors);
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
        const result = validate(definition.query, rawQuery ?? {});
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
        return errorResponse(
          'VALIDATION_ERROR',
          error.details ?? { [error.field]: [error.detail] },
          cors,
        );
      }
      if (error instanceof NotFoundError) {
        return errorResponse('NOT_FOUND', undefined, cors);
      }
      // **`ConflictError` より前に見る。** `CONFLICT` の既定文言（「すでに使用されています。」）では
      // 運用者に理由が伝わらないので、説明を添えて返す（029 設計 §6.3 / §11 #9）。
      // `Retry-After` を足すときも `cors` を落とさない（落とすと CORS 経由で読めなくなる）。
      if (error instanceof JobBusyError) {
        return errorResponse(
          'CONFLICT',
          { job: ['実行中のため受け付けられません。しばらくしてからやり直してください。'] },
          { ...cors, 'Retry-After': '10' },
        );
      }
      if (error instanceof ConflictError) {
        return errorResponse('CONFLICT', undefined, cors);
      }

      // 想定外の例外。**内容を応答へ出さない**（05_API設計.md §11）。
      // 原因の追跡はサーバー側のログで行う。
      log.error('unhandled error in route', {
        operationId: definition.operationId,
        reason: logReasonOf(error),
      });
      return errorResponse('INTERNAL_ERROR', undefined, cors);
    }
  };
}
