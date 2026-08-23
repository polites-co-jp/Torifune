import { z } from 'zod';
import { listDocumentedEndpoints, type EndpointSpec } from './registry';

/**
 * OpenAPI 文書を Zod スキーマから生成する（05_API設計.md §40）。
 *
 * **手で書かない。** 手で書いた仕様は必ず実装とずれる。
 */

const API_VERSION = 'v1';

interface OpenApiOperation {
  operationId: string;
  summary: string;
  security?: { session: string[] }[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

function jsonSchemaOf(schema: z.ZodType | undefined): unknown {
  if (schema === undefined) {
    return undefined;
  }
  // Zod v4 は JSON Schema への変換を標準で持つ。外部ライブラリを増やさない。
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

function responsesFor(endpoint: EndpointSpec): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '200': { description: '成功' },
    '422': { description: '入力エラー', content: { 'application/json': {} } },
    '500': { description: 'サーバー内部エラー' },
  };

  if (endpoint.permission !== null) {
    responses['401'] = { description: '未認証' };
    responses['403'] = { description: '権限不足' };
  }

  if (endpoint.method !== 'GET') {
    responses['403'] = { description: '権限不足、または CSRF 検証に失敗' };
  }

  return responses;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const endpoint of listDocumentedEndpoints()) {
    const operation: OpenApiOperation = {
      operationId: endpoint.operationId,
      summary: endpoint.summary,
      responses: responsesFor(endpoint),
    };

    if (endpoint.permission !== null) {
      operation.security = [{ session: [endpoint.permission] }];
    }

    const querySchema = jsonSchemaOf(endpoint.querySchema);
    if (querySchema !== undefined) {
      operation.parameters = [
        {
          name: 'query',
          in: 'query',
          schema: querySchema,
        },
      ];
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
          description: 'ログインで発行されるセッション Cookie。',
        },
      },
    },
    paths,
  };
}
