import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument } from './openapi';
import { registerEndpoint, resetEndpointRegistry, type EndpointSpec } from './registry';
import { dataEnvelope, pageEnvelope } from './schemas/envelope';

/**
 * OpenAPI 生成（05_API設計.md §40）。
 *
 * ここは登録内容だけを入力に取るので、実際のルートを読み込まずに検証できる。
 * 実際に登録されているエンドポイントの一覧は E2E（`e2e/api-foundation.spec.ts`）で固定する。
 */

function spec(overrides: Partial<EndpointSpec> & Pick<EndpointSpec, 'operationId'>): EndpointSpec {
  return {
    method: 'GET',
    path: '/things',
    summary: 'テスト用',
    permission: 'site.read',
    documented: true,
    sessionOnly: false,
    ...overrides,
  };
}

interface Operation {
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly security?: Record<string, string[]>[];
  readonly responses: Record<string, { description: string; content?: Record<string, unknown> }>;
  readonly 'x-required-permission'?: string;
}

function build(): {
  readonly paths: Record<string, Record<string, Operation>>;
  readonly components: { securitySchemes: Record<string, Record<string, unknown>> };
} {
  return buildOpenApiDocument() as unknown as ReturnType<typeof build>;
}

beforeEach(() => {
  resetEndpointRegistry();
});

describe('認証方式の宣言', () => {
  it('セッション Cookie と Bearer の両方を宣言する', () => {
    const schemes = build().components.securitySchemes;

    expect(schemes['session']).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'torifune_session',
    });
    expect(schemes['bearer']).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  /** 生成したクライアントが「どう送ればよいか」を推測せずに済むようにする。 */
  it('Bearer に bearerFormat がある', () => {
    expect(build().components.securitySchemes['bearer']?.['bearerFormat']).toBe('TorifuneApiToken');
  });

  it('認可が要る口は Cookie と Bearer のどちらでも呼べると宣言する', () => {
    registerEndpoint(spec({ operationId: 'listThings' }));

    expect(build().paths['/things']?.['get']?.security).toEqual([{ session: [] }, { bearer: [] }]);
  });

  /**
   * 宣言と実態をずらさない。
   * `sessionOnly` の口は Bearer を拒む（`api/route.ts`）。
   */
  it('sessionOnly の口は Cookie だけと宣言する', () => {
    registerEndpoint(spec({ operationId: 'listThings', sessionOnly: true }));

    expect(build().paths['/things']?.['get']?.security).toEqual([{ session: [] }]);
  });

  it('認可しない口には security を付けない', () => {
    registerEndpoint(spec({ operationId: 'listThings', permission: null }));

    expect(build().paths['/things']?.['get']?.security).toBeUndefined();
  });

  /**
   * scope 欄には書けない（apiKey / http では空配列が必須）ので、拡張フィールドで持つ。
   * 「誰が呼べるか」が分からないと、403 の理由が読み手に伝わらない。
   */
  it('必要な Permission を拡張フィールドで出す', () => {
    registerEndpoint(spec({ operationId: 'listThings', permission: 'site.write' }));

    expect(build().paths['/things']?.['get']?.['x-required-permission']).toBe('site.write');
  });
});

describe('応答スキーマ', () => {
  const thing = z.object({ id: z.string(), name: z.string() });

  it('単体の応答が data を持つ形で出る', () => {
    registerEndpoint(spec({ operationId: 'getThing', responseSchema: dataEnvelope(thing) }));

    const schema = build().paths['/things']?.['get']?.responses['200']?.content?.[
      'application/json'
    ] as { schema: { properties: Record<string, unknown> } };

    expect(Object.keys(schema.schema.properties)).toEqual(['data']);
  });

  it('一覧の応答が data と meta を持つ形で出る', () => {
    registerEndpoint(spec({ operationId: 'listThings', responseSchema: pageEnvelope(thing) }));

    const schema = build().paths['/things']?.['get']?.responses['200']?.content?.[
      'application/json'
    ] as { schema: { properties: Record<string, unknown> } };

    expect(Object.keys(schema.schema.properties).sort()).toEqual(['data', 'meta']);
  });

  it('作成は 201 に出る', () => {
    registerEndpoint(
      spec({
        operationId: 'createThing',
        method: 'POST',
        responseSchema: dataEnvelope(thing),
        successStatus: 201,
      }),
    );

    const responses = build().paths['/things']?.['post']?.responses;
    expect(responses?.['201']?.content).toBeDefined();
    expect(responses?.['200']).toBeUndefined();
  });

  it('204 は本文を持たない', () => {
    registerEndpoint(spec({ operationId: 'deleteThing', method: 'DELETE', successStatus: 204 }));

    const responses = build().paths['/things']?.['delete']?.responses;
    expect(responses?.['204']?.content).toBeUndefined();
    expect(responses?.['200']).toBeUndefined();
  });

  /** 未宣言のものは content を持たない。**どれが未宣言かが文書から分かる。** */
  it('未宣言なら content を持たない', () => {
    registerEndpoint(spec({ operationId: 'listThings' }));

    expect(build().paths['/things']?.['get']?.responses['200']?.content).toBeUndefined();
  });

  it('エラー応答にもスキーマが付く', () => {
    registerEndpoint(spec({ operationId: 'listThings' }));

    const responses = build().paths['/things']?.['get']?.responses;
    expect(responses?.['422']?.content).toBeDefined();
    expect(responses?.['401']?.content).toBeDefined();
    expect(responses?.['429']?.content).toBeDefined();
  });

  it('認可しない口には 401 / 403 を出さない', () => {
    registerEndpoint(spec({ operationId: 'listThings', permission: null }));

    const responses = build().paths['/things']?.['get']?.responses;
    expect(responses?.['401']).toBeUndefined();
    expect(responses?.['403']).toBeUndefined();
  });
});

describe('非推奨', () => {
  it('deprecated: true と説明が出る', () => {
    registerEndpoint(
      spec({
        operationId: 'listThings',
        deprecated: { since: '2026-09-01', replacedBy: '/stuff', removeAfter: '2027-03-01' },
      }),
    );

    const operation = build().paths['/things']?.['get'];
    expect(operation?.deprecated).toBe(true);
    expect(operation?.description).toContain('2026-09-01');
    expect(operation?.description).toContain('/stuff');
    expect(operation?.description).toContain('2027-03-01');
  });

  it('非推奨でなければ deprecated を出さない', () => {
    registerEndpoint(spec({ operationId: 'listThings' }));

    expect(build().paths['/things']?.['get']?.deprecated).toBeUndefined();
  });
});

describe('掲載範囲', () => {
  it('内部エンドポイントを載せない', () => {
    registerEndpoint(spec({ operationId: 'internalThing', path: '/internal', documented: false }));
    registerEndpoint(spec({ operationId: 'listThings' }));

    expect(Object.keys(build().paths)).toEqual(['/things']);
  });
});
