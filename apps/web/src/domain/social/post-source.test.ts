import { describe, expect, it } from 'vitest';

/**
 * 投稿の登録元の純関数（054-bulk-post-actions 設計 §5.6・§7.3・§8.8・§9.2、受け入れ条件 #5・#6）。
 *
 * **Domain 層の単体テスト。** DB も Plugin API も使わない。
 *
 * `domain/social/post-source.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （未作成の段階で `pnpm typecheck` を落とさない。053 実装プラン §8 の 19）。型は設計 §7.3・§8.8 から写す。
 */

type PostSource =
  | { readonly kind: 'screen' }
  | {
      readonly kind: 'token';
      readonly tokenId: string;
      readonly name: string;
      readonly revoked: boolean;
    }
  | { readonly kind: 'deleted_token'; readonly name: string };

type PostSourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

interface SourceToken {
  readonly id: string;
  readonly name: string;
  readonly revoked: boolean;
  readonly createdAt: Date;
}

interface PostLike {
  readonly createdByTokenId: string | null;
  readonly createdByTokenName: string | null;
}

interface PostSourceModule {
  readonly postSourceOf: (post: PostLike, tokens: readonly SourceToken[]) => PostSource;
  readonly parsePostSourceParam: (value: unknown) => PostSourceFilter | null;
  readonly postSourceParamOf: (filter: PostSourceFilter) => string;
}

const POST_SOURCE_MODULE: string = '@/domain/social/post-source';

async function load(): Promise<PostSourceModule> {
  const module = (await import(/* @vite-ignore */ POST_SOURCE_MODULE)) as Partial<PostSourceModule>;
  if (
    typeof module.postSourceOf !== 'function' ||
    typeof module.parsePostSourceParam !== 'function' ||
    typeof module.postSourceParamOf !== 'function'
  ) {
    throw new Error(
      'domain/social/post-source.ts に postSourceOf / parsePostSourceParam / postSourceParamOf が無い',
    );
  }
  return module as PostSourceModule;
}

const TOKEN_BLOG = '01920000-0000-7000-8000-00000000b106';
const TOKEN_SHOP = '01920000-0000-7000-8000-00000000540b';
const TOKEN_UNKNOWN = '01920000-0000-7000-8000-0000000000ff';
const ISSUED = new Date('2026-10-01T00:00:00.000Z');

const TOKENS: readonly SourceToken[] = [
  { id: TOKEN_BLOG, name: 'ブログ連携', revoked: false, createdAt: ISSUED },
  { id: TOKEN_SHOP, name: 'ショップ連携', revoked: true, createdAt: ISSUED },
];

// ---------------------------------------------------------------------------
// #5 postSourceOf
// ---------------------------------------------------------------------------

describe('#5 postSourceOf', () => {
  it('#5 createdByTokenId が対応表にある → token（対応表の名前・失効していない）', async () => {
    const { postSourceOf } = await load();

    expect(
      postSourceOf({ createdByTokenId: TOKEN_BLOG, createdByTokenName: 'ブログ連携' }, TOKENS),
    ).toEqual({ kind: 'token', tokenId: TOKEN_BLOG, name: 'ブログ連携', revoked: false });
  });

  it('#5 対応表のトークンが失効している → token・revoked: true', async () => {
    const { postSourceOf } = await load();

    expect(
      postSourceOf({ createdByTokenId: TOKEN_SHOP, createdByTokenName: 'ショップ連携' }, TOKENS),
    ).toEqual({ kind: 'token', tokenId: TOKEN_SHOP, name: 'ショップ連携', revoked: true });
  });

  it('#5 名前は対応表から取る（写しの名前と食い違っても対応表の名前）', async () => {
    const { postSourceOf } = await load();

    expect(
      postSourceOf({ createdByTokenId: TOKEN_BLOG, createdByTokenName: '古い写し' }, TOKENS),
    ).toMatchObject({ kind: 'token', name: 'ブログ連携' });
  });

  it('#5 createdByTokenId が対応表に無い → token（名前は createdByTokenName・revoked: false）', async () => {
    const { postSourceOf } = await load();

    expect(
      postSourceOf({ createdByTokenId: TOKEN_UNKNOWN, createdByTokenName: '別の連携' }, TOKENS),
    ).toEqual({ kind: 'token', tokenId: TOKEN_UNKNOWN, name: '別の連携', revoked: false });
  });

  it('#5 createdByTokenId が NULL で名前がある → deleted_token（名前）', async () => {
    const { postSourceOf } = await load();

    expect(
      postSourceOf({ createdByTokenId: null, createdByTokenName: '消えた連携' }, TOKENS),
    ).toEqual({ kind: 'deleted_token', name: '消えた連携' });
  });

  it('#5 両方 NULL → screen', async () => {
    const { postSourceOf } = await load();

    expect(postSourceOf({ createdByTokenId: null, createdByTokenName: null }, TOKENS)).toEqual({
      kind: 'screen',
    });
  });

  it('#5 対応表が空でも両方 NULL → screen', async () => {
    const { postSourceOf } = await load();

    expect(postSourceOf({ createdByTokenId: null, createdByTokenName: null }, [])).toEqual({
      kind: 'screen',
    });
  });
});

// ---------------------------------------------------------------------------
// #6 parsePostSourceParam / postSourceParamOf
// ---------------------------------------------------------------------------

describe('#6 parsePostSourceParam', () => {
  it("#6 'screen' → { kind: 'screen' }", async () => {
    const { parsePostSourceParam } = await load();

    expect(parsePostSourceParam('screen')).toEqual({ kind: 'screen' });
  });

  it("#6 'deleted' → { kind: 'deleted_token' }", async () => {
    const { parsePostSourceParam } = await load();

    expect(parsePostSourceParam('deleted')).toEqual({ kind: 'deleted_token' });
  });

  it("#6 'token:<UUID>' → { kind: 'token', tokenId }", async () => {
    const { parsePostSourceParam } = await load();

    expect(parsePostSourceParam(`token:${TOKEN_BLOG}`)).toEqual({
      kind: 'token',
      tokenId: TOKEN_BLOG,
    });
  });

  it("#6 'token:<大文字の UUID>' も token（同じ UUID として読む）", async () => {
    const { parsePostSourceParam } = await load();

    const parsed = parsePostSourceParam(`token:${TOKEN_BLOG.toUpperCase()}`);

    expect(parsed?.kind).toBe('token');
    expect(parsed !== null && parsed.kind === 'token' ? parsed.tokenId.toLowerCase() : null).toBe(
      TOKEN_BLOG,
    );
  });

  it.each([
    ["'token:abc'", 'token:abc'],
    ["'token:'", 'token:'],
    ["'other'", 'other'],
    ["''", ''],
    ['undefined', undefined],
    ['null', null],
    ["配列 ['screen']", ['screen']],
    [`配列 ['token:<UUID>']`, [`token:${TOKEN_BLOG}`]],
    ['数値 1', 1],
  ] as const)('#6 %s → null', async (_label, value) => {
    const { parsePostSourceParam } = await load();

    expect(parsePostSourceParam(value)).toBeNull();
  });
});

describe('#6 postSourceParamOf と往復', () => {
  it.each([
    ['screen', { kind: 'screen' }, 'screen'],
    ['deleted_token', { kind: 'deleted_token' }, 'deleted'],
    ['token', { kind: 'token', tokenId: TOKEN_BLOG }, `token:${TOKEN_BLOG}`],
  ] as const)(
    '#6 postSourceParamOf(%s) は設計 §9.2 のクエリの値',
    async (_label, filter, param) => {
      const { postSourceParamOf } = await load();

      expect(postSourceParamOf(filter)).toBe(param);
    },
  );

  it.each([
    ['screen', { kind: 'screen' }],
    ['deleted_token', { kind: 'deleted_token' }],
    ['token', { kind: 'token', tokenId: TOKEN_BLOG }],
  ] as const)('#6 parse(paramOf(%s)) が元に戻る', async (_label, filter) => {
    const { parsePostSourceParam, postSourceParamOf } = await load();

    expect(parsePostSourceParam(postSourceParamOf(filter))).toEqual(filter);
  });
});
