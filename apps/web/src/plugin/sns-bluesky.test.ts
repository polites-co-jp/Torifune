import type {
  PluginStore,
  PublisherLimits,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
  SocialPostView,
} from '@torifune/plugin-api';
import { isValidStoreKey } from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidManualUrl } from '@/domain/social/social';
import {
  pdsSettingsRegistration,
  resolvePdsUrl,
  validatePdsUrl,
} from '../../../../plugins/sns-bluesky/settings';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';
import {
  detectLinkFacets,
  graphemeCount,
  utf8ByteLength,
} from '../../../../plugins/sns-bluesky/text';

/**
 * Bluesky 配信 Plugin の単体検査（036-sns-bluesky 設計 §10）。
 *
 * **実際の Bluesky を叩かない。** このファイルが見るのは
 * 登録の形（#9〜#12）・純関数（`text.ts`）・`validate()`（#16〜#26）・
 * `manual()`（#27〜#32）・`pds-url` の設定（#58 / #59）だけで、
 * どれも外部 I/O を持たない。
 *
 * #52：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

/** `PublisherLimits` が持つキー（型からは実行時に取れないので列挙する）。 */
const PUBLISHER_LIMIT_KEYS = [
  'bodyMaxLength',
  'mediaRequired',
  'mediaMax',
] as const satisfies readonly (keyof PublisherLimits)[];

interface RecordingStore {
  readonly store: PluginStore;
  readonly calls: string[];
}

/** 最小の Key-Value Store。**呼ばれたことを記録する**（#30）。 */
function recordingStore(values: Map<string, unknown> = new Map()): RecordingStore {
  const calls: string[] = [];
  const store: PluginStore = {
    get: async <T = unknown>(key: string): Promise<T | null> => {
      calls.push(`get:${key}`);
      return values.has(key) ? (values.get(key) as T) : null;
    },
    set: async <T = unknown>(key: string, value: T): Promise<void> => {
      calls.push(`set:${key}`);
      values.set(key, value);
    },
    delete: () => {
      throw new Error('使わない');
    },
    keys: () => {
      throw new Error('使わない');
    },
    setSecret: () => {
      throw new Error('使わない');
    },
    getSecret: () => {
      throw new Error('使わない');
    },
    hasSecret: () => {
      throw new Error('使わない');
    },
  };
  return { store, calls };
}

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'bluesky',
    displayName: 'とりふね',
    handle: 'torifune.example',
    status: 'active',
    credentialConfigured: true,
    ...overrides,
  };
}

function draft(overrides: Partial<SocialPostDraftView> = {}): SocialPostDraftView {
  return {
    body: 'こんにちは',
    scheduledAt: null,
    deliveryMode: 'auto',
    media: [],
    link: null,
    providerOptions: {},
    ...overrides,
  };
}

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000b001',
    socialAccountId: accountView().id,
    body: 'こんにちは',
    scheduledAt: '2026-09-23T12:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    failureReason: null,
    deliveryMode: 'manual',
    media: [],
    link: null,
    providerOptions: {},
    externalRef: null,
    externalId: null,
    externalUrl: null,
    failedAt: null,
    ...overrides,
  };
}

let realFetch: typeof globalThis.fetch;
let fetchCalls: number;
let store: RecordingStore;

beforeEach(() => {
  // #52：本物の `fetch` を呼んだら落ちる。差し替え忘れを検出する。
  realFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = ((): never => {
    fetchCalls += 1;
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
  store = recordingStore();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function publisher() {
  return createBlueskyPublisher({ store: store.store });
}

/** `validate()` を同期で呼ぶ（#25：Promise を返したらここで落ちる）。 */
function validate(
  post: SocialPostDraftView,
  account: SocialAccountView = accountView(),
): readonly PublisherValidationProblem[] {
  const registration = publisher();
  if (registration.validate === undefined) {
    throw new Error('validate() が実装されていない');
  }
  const result = registration.validate({ post, account });
  if (!Array.isArray(result)) {
    throw new Error('validate() が同期で配列を返していない');
  }
  return result;
}

function fieldsOf(problems: readonly PublisherValidationProblem[]): string[] {
  return problems.map((problem) => problem.field);
}

describe('登録（#9〜#12）', () => {
  it('#9 provider が bluesky で、label が Bluesky', () => {
    const registration = publisher();

    expect(registration.provider).toBe('bluesky');
    expect(registration.label).toBe('Bluesky');
  });

  it('#10 資格情報の項目は identifier と appPassword の2つだけ', () => {
    const fields = publisher().credentialFields;

    expect(fields.map((field) => field.key)).toEqual(['identifier', 'appPassword']);
    expect(fields[0]?.kind).toBe('text');
    expect(fields[1]?.kind).toBe('secret');
  });

  it('#10 appPassword の説明が「ログイン」と「App Password」の両方に触れている', () => {
    // ここに書かないと、利用者はログインパスワードを入れる（設計 §5.1）。
    const description = publisher().credentialFields[1]?.description ?? '';

    expect(description).toContain('ログイン');
    expect(description).toContain('App Password');
  });

  it('#11 limits は bodyMaxLength: 3000 と mediaMax: 4 で、mediaRequired を宣言しない', () => {
    // 300 にすると Bluesky が受ける投稿を Core が 422 で弾く（設計 §9.2）。
    const limits = publisher().limits;

    expect(limits).toEqual({ bodyMaxLength: 3000, mediaMax: 4 });
    expect(limits).not.toHaveProperty('mediaRequired');
  });

  it('#12 limits のキーは PublisherLimits の部分集合', () => {
    const keys = Object.keys(publisher().limits ?? {});

    for (const key of keys) {
      expect(PUBLISHER_LIMIT_KEYS as readonly string[], key).toContain(key);
    }
  });
});

describe('text.ts：数え方（T2）', () => {
  it('grapheme は結合した絵文字を1つと数える', () => {
    const family = '👨‍👩‍👧‍👦';

    expect(graphemeCount(family)).toBe(1);
    expect(family.length).toBeGreaterThan(1);
  });

  it('grapheme はサロゲートペアを1つと数える', () => {
    const fish = '𩸽';

    expect(graphemeCount(fish)).toBe(1);
    expect(fish.length).toBe(2);
  });

  it('grapheme は肌色修飾を1つと数える', () => {
    const thumb = '👍🏽';

    expect(graphemeCount(thumb)).toBe(1);
    expect(thumb.length).toBe(4);
  });

  it('grapheme は異体字セレクタを1つと数える', () => {
    const text = '☺️';

    expect(graphemeCount(text)).toBe(1);
    expect(text.length).toBe(2);
  });

  it('grapheme は空文字を0と数える', () => {
    expect(graphemeCount('')).toBe(0);
  });

  it('grapheme は日本語を1文字ずつ数える', () => {
    expect(graphemeCount('こんにちは')).toBe(5);
  });

  it('UTF-8 のバイト数を数える（String.length と違う）', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('あ')).toBe(3);
    expect(utf8ByteLength('👍')).toBe(4);
    expect(utf8ByteLength('')).toBe(0);
  });
});

describe('text.ts：detectLinkFacets（T6。#39〜#41 の純関数側）', () => {
  it('#39 位置は UTF-8 のバイト単位で、UTF-16 の添字と一致しない', () => {
    // 日本語を前に置くと、UTF-16 の添字（6）とバイト位置（16）が食い違う。
    const body = 'こんにちは https://example.com です';
    const [facet] = detectLinkFacets(body);

    expect(facet?.index.byteStart).toBe(16);
    expect(facet?.index.byteEnd).toBe(16 + 'https://example.com'.length);
    expect(body.indexOf('https://')).toBe(6);
  });

  it('#39 feature は app.bsky.richtext.facet#link', () => {
    const [facet] = detectLinkFacets('見てね https://example.com');

    expect(facet?.features).toHaveLength(1);
    expect(facet?.features[0]?.$type).toBe('app.bsky.richtext.facet#link');
    expect(facet?.features[0]?.uri).toBe('https://example.com');
  });

  it('#40 末尾の句読点を URL に含めない', () => {
    const [facet] = detectLinkFacets('詳しくは https://example.com/a。');

    expect(facet?.features[0]?.uri).toBe('https://example.com/a');
    expect(utf8ByteLength('詳しくは ')).toBe(facet?.index.byteStart);
  });

  it('#40 末尾の閉じ括弧を URL に含めない', () => {
    expect(detectLinkFacets('(https://example.com/a)')[0]?.features[0]?.uri).toBe(
      'https://example.com/a',
    );
    expect(detectLinkFacets('「https://example.com/a」')[0]?.features[0]?.uri).toBe(
      'https://example.com/a',
    );
    expect(detectLinkFacets('ここ https://example.com/a.')[0]?.features[0]?.uri).toBe(
      'https://example.com/a',
    );
  });

  it('#41 URL が無ければ空配列', () => {
    expect(detectLinkFacets('リンクはありません')).toEqual([]);
  });

  it('複数の URL をすべて拾う', () => {
    const facets = detectLinkFacets('https://a.example.com と https://b.example.com');

    expect(facets).toHaveLength(2);
    expect(facets[1]?.features[0]?.uri).toBe('https://b.example.com');
  });

  it('http の URL も拾う', () => {
    expect(detectLinkFacets('http://example.com')[0]?.features[0]?.uri).toBe('http://example.com');
  });
});

describe('validate()（#16〜#26）', () => {
  it('#16 300 grapheme ちょうどは通る', () => {
    expect(validate(draft({ body: 'あ'.repeat(300) }))).toEqual([]);
  });

  it('#16 301 grapheme は body の問題が1件', () => {
    const problems = validate(draft({ body: 'あ'.repeat(301) }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('body');
    expect(problems[0]?.message).toContain('300');
  });

  it('#17 絵文字は grapheme で数える（String.length では数えない）', () => {
    // `'👍'.repeat(300)` は String.length が 600 だが 300 grapheme。
    //
    // **設計 §10 #17 が挙げる `'👨‍👩‍👧‍👦'.repeat(300)` は使えない。**
    // 家族の絵文字は 1 つで 25 バイトあり、300 個で 7,500 バイトになるため、
    // 設計 §9.3 の 2（UTF-8 は 3,000 バイトまで）に必ず掛かる。
    // §9.3 を正とし、その入力は #18 の側で見る。
    const body = '👍'.repeat(300);

    expect(body.length).toBeGreaterThan(300);
    expect(validate(draft({ body }))).toEqual([]);
  });

  it('#17 絵文字が 301 個なら body の問題', () => {
    expect(fieldsOf(validate(draft({ body: '👍'.repeat(301) })))).toContain('body');
  });

  it('#18 300 grapheme 以内でも UTF-8 が 3000 バイトを超えたら body の問題', () => {
    // 家族の絵文字は 1 つ 25 バイト。150 個で 150 grapheme・3,750 バイト。
    const problems = validate(draft({ body: '👨‍👩‍👧‍👦'.repeat(150) }));

    expect(graphemeCount('👨‍👩‍👧‍👦'.repeat(150))).toBe(150);
    expect(utf8ByteLength('👨‍👩‍👧‍👦'.repeat(150))).toBeGreaterThan(3000);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('body');
    expect(problems[0]?.message).toContain('3000');
  });

  it('#19 media の alt が 1001 grapheme なら media の問題', () => {
    const problems = validate(
      draft({ media: [{ url: 'https://example.com/a.png', alt: 'あ'.repeat(1001) }] }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('media');
  });

  it('#19 media の alt が 1000 grapheme なら通る', () => {
    expect(
      validate(draft({ media: [{ url: 'https://example.com/a.png', alt: 'あ'.repeat(1000) }] })),
    ).toEqual([]);
  });

  it('#19 media の alt が null なら通る', () => {
    expect(validate(draft({ media: [{ url: 'https://example.com/a.png', alt: null }] }))).toEqual(
      [],
    );
  });

  it('#19 何件目の alt かが分かる', () => {
    const problems = validate(
      draft({
        media: [
          { url: 'https://example.com/a.png', alt: 'ok' },
          { url: 'https://example.com/b.png', alt: 'あ'.repeat(1001) },
        ],
      }),
    );

    expect(problems[0]?.message).toContain('2');
  });

  it('#20 auto で media と link を同時に指定したら link の問題', () => {
    // Bluesky の embed は1つしか持てない（設計 §6.8）。
    const problems = validate(
      draft({
        deliveryMode: 'auto',
        media: [{ url: 'https://example.com/a.png', alt: null }],
        link: 'https://example.com/',
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('link');
  });

  it('#20 auto で media だけなら通る', () => {
    expect(
      validate(
        draft({ deliveryMode: 'auto', media: [{ url: 'https://example.com/a.png', alt: null }] }),
      ),
    ).toEqual([]);
  });

  it('#20 auto で link だけなら通る', () => {
    expect(validate(draft({ deliveryMode: 'auto', link: 'https://example.com/' }))).toEqual([]);
  });

  it('#21 manual では body + 改行 + link で 300 grapheme を数える', () => {
    // 手動投稿で実際に渡す文字列がこれだから（設計 §9.4）。
    const post = draft({
      deliveryMode: 'manual',
      body: 'あ'.repeat(299),
      link: 'https://example.com/aaaa',
    });
    const problems = validate(post);

    // 042 で、手動投稿の intent URL が 2048 文字を超える問題も重ねて返るようになった
    // （042-social-api-input-fixes 設計 §10.7・受け入れ条件 7）。grapheme の問題が含まれることは message で見る。
    expect(fieldsOf(problems)).toEqual(['body', 'body']);
    expect(problems.some((problem) => problem.message.includes('300文字'))).toBe(true);
  });

  it('#21 manual で合計が 300 grapheme 以内なら通る', () => {
    expect(
      validate(
        draft({
          deliveryMode: 'manual',
          body: 'あ'.repeat(100),
          link: 'https://example.com/aaaa',
        }),
      ),
    ).toEqual([]);
  });

  it('#21 同じ本文でも auto なら link を足して数えない', () => {
    expect(
      validate(
        draft({ deliveryMode: 'auto', body: 'あ'.repeat(299), link: 'https://example.com/aaaa' }),
      ),
    ).toEqual([]);
  });

  it('#22 providerOptions.langs が文字列の配列なら通る', () => {
    expect(validate(draft({ providerOptions: { langs: ['ja'] } }))).toEqual([]);
  });

  it('#22 providerOptions.langs が配列でなければ問題', () => {
    expect(fieldsOf(validate(draft({ providerOptions: { langs: 'ja' } })))).toEqual([
      'providerOptions.langs',
    ]);
  });

  it('#22 providerOptions.langs が4件なら問題', () => {
    expect(
      fieldsOf(validate(draft({ providerOptions: { langs: ['a1', 'b1', 'c1', 'd1'] } }))),
    ).toEqual(['providerOptions.langs']);
  });

  it('#22 providerOptions.langs の要素が文字列でなければ問題', () => {
    expect(fieldsOf(validate(draft({ providerOptions: { langs: [1] } })))).toEqual([
      'providerOptions.langs',
    ]);
  });

  it('#22 providerOptions.langs の要素が短すぎ・長すぎなら問題', () => {
    expect(fieldsOf(validate(draft({ providerOptions: { langs: ['j'] } })))).toEqual([
      'providerOptions.langs',
    ]);
    expect(fieldsOf(validate(draft({ providerOptions: { langs: ['j'.repeat(17)] } })))).toEqual([
      'providerOptions.langs',
    ]);
  });

  it('#23 providerOptions に知らないキーがあれば、そのキー名で問題を返す', () => {
    const problems = validate(draft({ providerOptions: { mystery: 1 } }));

    expect(fieldsOf(problems)).toEqual(['providerOptions.mystery']);
    expect(problems[0]?.message).toContain('mystery');
  });

  it('#24 providerOptions が null でも例外を投げない', () => {
    const post = draft({
      providerOptions: null as unknown as Readonly<Record<string, unknown>>,
    });

    expect(() => validate(post)).not.toThrow();
    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#24 providerOptions が配列でも例外を投げない', () => {
    const post = draft({
      providerOptions: ['ja'] as unknown as Readonly<Record<string, unknown>>,
    });

    expect(() => validate(post)).not.toThrow();
    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#24 providerOptions が深い入れ子でも例外を投げない', () => {
    const post = draft({ providerOptions: { deep: { a: { b: { c: { d: [1, 2, 3] } } } } } });

    expect(() => validate(post)).not.toThrow();
    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#24 providerOptions が循環参照を含んでも例外を投げない', () => {
    // JSON.stringify で舐めると落ちる（実装プラン §7 の 5）。
    const circular: Record<string, unknown> = { langs: ['ja'] };
    circular['self'] = circular;
    const post = draft({ providerOptions: circular });

    expect(() => validate(post)).not.toThrow();
    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#24 media の alt が壊れていても例外を投げない', () => {
    const post = draft({
      media: [{ url: 'https://example.com/a.png', alt: undefined as unknown as string | null }],
    });

    expect(() => validate(post)).not.toThrow();
  });

  it('#25 同期で返り、fetch を1度も呼ばない', () => {
    const registration = publisher();
    const result = registration.validate?.({ post: draft(), account: accountView() });

    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
    expect(fetchCalls).toBe(0);
  });

  it('#25 store を読まない', () => {
    validate(draft());

    expect(store.calls).toEqual([]);
  });

  it('#26 違反が複数あればすべて返る', () => {
    const problems = validate(
      draft({
        body: 'あ'.repeat(301),
        media: [{ url: 'https://example.com/a.png', alt: 'あ'.repeat(1001) }],
      }),
    );

    expect(problems).toHaveLength(2);
    expect(fieldsOf(problems).sort()).toEqual(['body', 'media']);
  });
});

describe('manual()（#27〜#32）', () => {
  function manual(post: SocialPostView) {
    const registration = publisher();
    if (registration.manual === undefined) {
      throw new Error('manual() が実装されていない');
    }
    const result = registration.manual({ post, account: accountView() });
    if (result instanceof Promise) {
      throw new Error('manual() が同期で返していない');
    }
    return result;
  }

  it('#27 link が無ければ本文だけを intent URL へ載せる', () => {
    const body = 'こんにちは、とりふね';
    const result = manual(postView({ body, link: null }));

    expect(result.url).toBe(`https://bsky.app/intent/compose?text=${encodeURIComponent(body)}`);
    expect(result.note ?? '').not.toBe('');
  });

  it('#28 link があれば本文の末尾へ改行して足す', () => {
    const body = 'こんにちは';
    const link = 'https://example.com/a';
    const result = manual(postView({ body, link }));

    expect(new URL(result.url).searchParams.get('text')).toBe(`${body}\n${link}`);
  });

  it('#29 記号・改行・絵文字がそのまま戻る', () => {
    const body = 'A&B #tag 1+1\n改行と絵文字 👨‍👩‍👧‍👦 と ? と =';
    const result = manual(postView({ body, link: null }));

    expect(new URL(result.url).searchParams.get('text')).toBe(body);
  });

  it('#30 store を読まず、fetch も呼ばず、同期で返る', () => {
    const registration = publisher();
    const result = registration.manual?.({ post: postView(), account: accountView() });

    expect(result).not.toBeInstanceOf(Promise);
    expect(store.calls).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it('#31 返す URL は Core の isValidManualUrl に通る', () => {
    expect(isValidManualUrl(manual(postView()).url)).toBe(true);
    expect(isValidManualUrl(manual(postView({ body: 'あ'.repeat(200), link: null })).url)).toBe(
      true,
    );
  });

  it('#32 note は「画像」と「投稿画面」に触れ、添付を断定しない', () => {
    // 手動投稿に media は付けられない（Core が 422）。
    // 「画像は投稿画面で添付してください」と書くと、
    // 付けたはずの画像が落ちたと読まれる（設計 §9.4）。
    const note = manual(postView()).note ?? '';

    expect(note).toContain('画像');
    expect(note).toContain('投稿画面');
    expect(note).toContain('添える場合');
    expect(note).not.toMatch(/画像は[^。]*添付してください/);
  });
});

describe('pds-url の設定（#58 / #59）', () => {
  const INVALID_VALUES = [
    'http://pds.example.com',
    'https://user:pw@pds.example.com',
    'ほげ',
    'https://pds.example.com/path',
    'https://pds.example.com/?a=1',
    'https://pds.example.com/#x',
    `https://pds.example.com/${'a'.repeat(2048)}`,
  ];

  /** `registerSettings` の `validate` を同期で呼ぶ（保存は待たせない）。 */
  function validateSettings(
    values: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> | null {
    const result = pdsSettingsRegistration.validate?.(values);
    if (result === undefined) {
      throw new Error('registerSettings の validate が無い');
    }
    if (result instanceof Promise) {
      throw new Error('registerSettings の validate が同期で返していない');
    }
    return result;
  }

  it('#58 不正な値には pds-url の問題を返す', () => {
    for (const value of INVALID_VALUES) {
      const problems = validateSettings({ 'pds-url': value });

      expect(problems, value).not.toBeNull();
      expect(Object.keys(problems ?? {}), value).toEqual(['pds-url']);
      expect(typeof (problems ?? {})['pds-url'], value).toBe('string');
    }
  });

  it('#58 空文字と既定の URL には null を返す', () => {
    expect(validateSettings({ 'pds-url': '' })).toBeNull();
    expect(validateSettings({ 'pds-url': 'https://bsky.social' })).toBeNull();
    expect(validateSettings({ 'pds-url': 'https://bsky.social/' })).toBeNull();
    expect(validateSettings({})).toBeNull();
  });

  it('#58 validate は同期で返る', () => {
    expect(pdsSettingsRegistration.validate?.({ 'pds-url': '' })).not.toBeInstanceOf(Promise);
  });

  it('#58 validatePdsUrl は不正な値に文言を、正しい値に null を返す', () => {
    // 配信時にもう一度掛けるため、検査そのものが取り出せる必要がある（設計 §7.2）。
    for (const value of INVALID_VALUES) {
      expect(typeof validatePdsUrl(value), value).toBe('string');
    }
    expect(validatePdsUrl('')).toBeNull();
    expect(validatePdsUrl('https://bsky.social')).toBeNull();
  });

  it('#58 http を許さない', () => {
    // そこへ App Password を平文で送ることになる（設計 §7.2）。
    expect(validatePdsUrl('http://localhost:3000')).not.toBeNull();
    expect(validatePdsUrl('http://bsky.social')).not.toBeNull();
  });

  it('#59 設定の項目は pds-url の1つだけで kind は text', () => {
    // secret にすると、どこへ App Password を送っているかを運用者が確かめられない。
    expect(pdsSettingsRegistration.fields).toHaveLength(1);
    expect(pdsSettingsRegistration.fields[0]?.key).toBe('pds-url');
    expect(pdsSettingsRegistration.fields[0]?.kind).toBe('text');
  });

  it('#59 キーが Key-Value Store のキーとして保存できる', () => {
    // `pdsUrl` は大文字を含むので保存できない（設計 §7.1）。
    expect(isValidStoreKey(pdsSettingsRegistration.fields[0]?.key ?? '')).toBe(true);
    expect(isValidStoreKey('pdsUrl')).toBe(false);
  });

  it('#59 説明に送信先であることが書いてある', () => {
    const description = pdsSettingsRegistration.fields[0]?.description ?? '';

    expect(description).toContain('App Password');
    expect(description).toContain('https://bsky.social');
  });

  it('未設定なら既定の PDS へ落とす', async () => {
    expect(await resolvePdsUrl(store.store)).toEqual({ ok: true, url: 'https://bsky.social' });
  });

  it('空文字でも既定の PDS へ落とす', async () => {
    const stored = recordingStore(new Map([['pds-url', '']]));

    expect(await resolvePdsUrl(stored.store)).toEqual({ ok: true, url: 'https://bsky.social' });
  });

  it('設定された PDS を末尾のスラッシュ無しで返す', async () => {
    const stored = recordingStore(new Map([['pds-url', 'https://pds.example.com/']]));

    expect(await resolvePdsUrl(stored.store)).toEqual({
      ok: true,
      url: 'https://pds.example.com',
    });
  });

  it('保存済みの値が不正なら配信時にも断る', async () => {
    // 保存時に通っても、配信時にもう一度見る（設計 §7.2）。
    const stored = recordingStore(new Map([['pds-url', 'http://pds.example.com']]));
    const resolved = await resolvePdsUrl(stored.store);

    expect(resolved.ok).toBe(false);
  });
});
