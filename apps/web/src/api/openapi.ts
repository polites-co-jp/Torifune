import { z } from 'zod';
import { deprecationDescription } from './deprecation';
import { errorEnvelopeSchema } from './schemas/envelope';
import { listDocumentedEndpoints, type EndpointSpec } from './registry';

/**
 * OpenAPI 文書を Zod スキーマから生成する（05_API設計.md §40）。
 *
 * **手で書かない。** 手で書いた仕様は必ず実装とずれる。
 *
 * §40 は「リクエスト・レスポンスの形式」を機械的に参照できることを求めている。
 * 認証方式（§12・§13・§37）も宣言する。
 * 宣言が無いと、生成したクライアントは認証の付け方を推測することになる。
 */

const API_VERSION = 'v1';

/** OpenAPI の Security Requirement。apiKey / http の場合、値は空配列でなければならない。 */
type SecurityRequirement = Record<string, string[]>;

interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  deprecated?: true;
  security?: SecurityRequirement[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
  /**
   * 必要な Permission。
   *
   * `security` の scope 欄には書けない（apiKey / http では空配列が必須）ので、
   * 拡張フィールドで持つ。**「誰が呼べるか」は仕様の一部**であり、
   * 書かないと 403 の理由が読み手に分からない。
   */
  'x-required-permission'?: string;
}

function jsonSchemaOf(schema: z.ZodType | undefined): unknown {
  if (schema === undefined) {
    return undefined;
  }
  // Zod v4 は JSON Schema への変換を標準で持つ。外部ライブラリを増やさない。
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

/** 成功時のステータス。既定は 200。 */
function successStatusOf(endpoint: EndpointSpec): string {
  return String(endpoint.successStatus ?? 200);
}

const ERROR_CONTENT = {
  'application/json': { schema: z.toJSONSchema(errorEnvelopeSchema, { io: 'output' }) },
};

function responsesFor(endpoint: EndpointSpec): Record<string, unknown> {
  const status = successStatusOf(endpoint);
  const responseSchema = jsonSchemaOf(endpoint.responseSchema);

  const success: Record<string, unknown> =
    status === '204'
      ? { description: '成功（本文なし）' }
      : {
          description: '成功',
          // 応答スキーマが未宣言のものは content を持たない。
          // **どれが未宣言かが文書から分かる**状態にしておく。
          ...(responseSchema === undefined
            ? {}
            : { content: { 'application/json': { schema: responseSchema } } }),
        };

  const responses: Record<string, unknown> = {
    [status]: success,
    '422': { description: '入力エラー', content: ERROR_CONTENT },
    '429': { description: 'Rate Limit 超過', content: ERROR_CONTENT },
    '500': { description: 'サーバー内部エラー', content: ERROR_CONTENT },
  };

  if (endpoint.permission !== null) {
    responses['401'] = { description: '未認証', content: ERROR_CONTENT };
    responses['403'] = { description: '権限不足', content: ERROR_CONTENT };
  }

  if (endpoint.method !== 'GET') {
    responses['403'] = {
      description: '権限不足、または CSRF 検証に失敗',
      content: ERROR_CONTENT,
    };
  }

  return responses;
}

/**
 * エンドポイントごとの認証要件。
 *
 * **実態に合わせる。** `defineRoute` は Bearer が付いていれば Bearer で認証し、
 * 無ければセッション Cookie で認証する（`api/route.ts`）。
 * `sessionOnly` の口だけは Bearer を拒む（021-api-token 設計 §5）。
 */
function securityFor(endpoint: EndpointSpec): SecurityRequirement[] | undefined {
  if (endpoint.permission === null) {
    // 認可しない口。認証してもしなくても呼べる。
    return undefined;
  }
  if (endpoint.sessionOnly) {
    return [{ session: [] }];
  }
  return [{ session: [] }, { bearer: [] }];
}

function descriptionFor(endpoint: EndpointSpec): string | undefined {
  if (endpoint.deprecated === undefined) {
    return undefined;
  }
  return deprecationDescription(endpoint.deprecated);
}

interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly schema: unknown;
  readonly description?: string;
}

/**
 * `/sites/{id}` の `{id}` を取り出す。
 *
 * **OpenAPI 3.1 では、パスに書いた変数に対応する parameter が必須。**
 * 無いと文書として成立せず、クライアント生成（05_API設計.md §40）に使えない。
 */
function pathParametersOf(path: string): OpenApiParameter[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1] ?? '',
    in: 'path' as const,
    // パスの一部なので常に必須。
    required: true,
    schema: { type: 'string' },
  }));
}

/**
 * クエリを**1件ずつ**の parameter にする。
 *
 * **スキーマ全体を1個の `query` という parameter にしてはいけない。**
 * そうすると、この文書から生成したクライアントは
 * `?page=1&perPage=20` ではなく `?query=...` を送ることになる。
 */
function queryParametersOf(endpoint: EndpointSpec): OpenApiParameter[] {
  const schema = jsonSchemaOf(endpoint.querySchema);
  if (schema === undefined) {
    return [];
  }

  const object = schema as {
    properties?: Record<string, unknown>;
    required?: readonly string[];
  };
  const properties = object.properties ?? {};
  const required = new Set(object.required ?? []);

  return Object.entries(properties).map(([name, propertySchema]) => {
    const described = propertySchema as { description?: string };
    return {
      name,
      in: 'query' as const,
      required: required.has(name),
      schema: propertySchema,
      ...(described.description === undefined ? {} : { description: described.description }),
    };
  });
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const endpoint of listDocumentedEndpoints()) {
    const operation: OpenApiOperation = {
      operationId: endpoint.operationId,
      summary: endpoint.summary,
      responses: responsesFor(endpoint),
    };

    const description = descriptionFor(endpoint);
    if (description !== undefined) {
      operation.description = description;
    }
    if (endpoint.deprecated !== undefined) {
      operation.deprecated = true;
    }

    const security = securityFor(endpoint);
    if (security !== undefined) {
      operation.security = security;
    }
    if (endpoint.permission !== null) {
      operation['x-required-permission'] = endpoint.permission;
    }

    const parameters = [...pathParametersOf(endpoint.path), ...queryParametersOf(endpoint)];
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    const bodySchema = jsonSchemaOf(endpoint.bodySchema);
    if (bodySchema !== undefined) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: bodySchema } },
      };
    }

    paths[endpoint.path] ??= {};
    (paths[endpoint.path] as Record<string, OpenApiOperation>)[endpoint.method.toLowerCase()] =
      operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Torifune API',
      version: API_VERSION,
      description:
        'Torifune の Public API。Plugin API はこの文書には含まれない（別途 SDK として提供する）。',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'torifune_session',
          description:
            'ログインで発行されるセッション Cookie（HttpOnly）。' +
            'ブラウザからの更新系では CSRF トークン（`X-CSRF-Token` ヘッダ）も要る。',
        },
        bearer: {
          type: 'http',
          scheme: 'bearer',
          // 発行した Token をそのまま `Authorization: Bearer <token>` で送る。
          // JWT ではないので、bearerFormat にその旨を書く。
          bearerFormat: 'TorifuneApiToken',
          description:
            'API Token（05_API設計.md §37-38）。`Authorization: Bearer <token>` で送る。' +
            'Bearer では CSRF 検証を行わない（Cookie の自動送信が無いため）。' +
            'API Token 自体の管理 API はセッション認証だけを受け付ける。',
        },
      },
    },
    paths,
  };
}
