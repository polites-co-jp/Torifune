import type {
  PublisherLimits,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countHashtags, countMentions } from '../../../../plugins/sns-instagram/caption';
import {
  CAROUSEL_CHILD_CONCURRENCY,
  CREATE_CONTAINER_TIMEOUT_MS,
  GRAPH_API_BASE_URL,
  GRAPH_API_VERSION,
  KNOWN_GRAPH_ERROR_CODES,
  KNOWN_GRAPH_ERROR_SUBCODES,
  MEDIA_PUBLISH_TIMEOUT_MS,
  PERMALINK_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_ROUNDS,
  PREPARE_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  REFRESH_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  classifyGraphError,
  describeGraphCode,
  describeGraphSubcode,
  isAcceptablePermalink,
  isValidFbtraceId,
  isValidGraphId,
  retryAfterMsFrom,
} from '../../../../plugins/sns-instagram/graph';
import { createInstagramPublisher } from '../../../../plugins/sns-instagram/social';
import {
  TOKEN_MAX_LIFETIME_MS,
  TOKEN_REFRESH_THRESHOLD_MS,
  expiryFromExpiresIn,
  isValidAccessToken,
  isValidIgUserId,
  parseExpiry,
  shouldRefresh,
} from '../../../../plugins/sns-instagram/token';

/**
 * Instagram 配信 Plugin の単体検査（038-sns-instagram 設計 §10）。
 *
 * **実際の Instagram を叩かない。** このファイルが見るのは
 * 登録の形（#12〜#15）・`validate()`（#19〜#28）・純関数（`caption.ts` / `token.ts` /
 * `graph.ts` の分類・`retryAfterMsFrom`・ID と `permalink` の形）だけで、どれも外部 I/O を持たない。
 *
 * #97：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

/** `PublisherLimits` が持つキー（型からは実行時に取れないので列挙する）。 */
const PUBLISHER_LIMIT_KEYS = [
  'bodyMaxLength',
  'mediaRequired',
  'mediaMax',
] as const satisfies readonly (keyof PublisherLimits)[];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 期限の判定の基準にする「いま」。 */
const NOW = new Date('2026-09-23T12:00:00.000Z');

function daysFromNow(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() + days * DAY_MS + extraMs);
}

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'instagram',
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
    media: [{ url: 'https://cdn.example.com/a.jpg', alt: null }],
    link: null,
    providerOptions: {},
    ...overrides,
  };
}

let realFetch: typeof globalThis.fetch;
let fetchCalls: number;

beforeEach(() => {
  // #97：本物の `fetch` を呼んだら落ちる。差し替え忘れを検出する。
  realFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = ((): never => {
    fetchCalls += 1;
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function publisher() {
  return createInstagramPublisher();
}

/** `validate()` を同期で呼ぶ（#27：Promise を返したらここで落ちる）。 */
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

function hashtags(count: number, mark = '#'): string {
  return Array.from({ length: count }, (_, index) => `${mark}tag${index}`).join(' ');
}

function mentions(count: number): string {
  return Array.from({ length: count }, (_, index) => `@user${index}`).join(' ');
}

/* -------------------------------------------------------------------------- */
/* 登録（#12〜#15）                                                              */
/* -------------------------------------------------------------------------- */

describe('登録（#12〜#15）', () => {
  it('#12 provider が instagram で、label が Instagram', () => {
    const registration = publisher();

    expect(registration.provider).toBe('instagram');
    expect(registration.label).toBe('Instagram');
  });

  it('#13 資格情報の項目は igUserId / accessToken / accessTokenExpiresAt の3つちょうど', () => {
    // **後から足せない**（設計 §5.2）。3 つ目まで最初の版で決め切る。
    const fields = publisher().credentialFields;

    expect(fields.map((field) => field.key)).toEqual([
      'igUserId',
      'accessToken',
      'accessTokenExpiresAt',
    ]);
  });

  it('#13 kind は text / secret / text', () => {
    const fields = publisher().credentialFields;

    expect(fields.map((field) => field.kind)).toEqual(['text', 'secret', 'text']);
  });

  it('#13 accessTokenExpiresAt の説明に unknown が現れる', () => {
    // 期限が分からない人の逃げ道。次の配信の成功で正しい期限に直る（設計 §5.2）。
    const field = publisher().credentialFields.find((item) => item.key === 'accessTokenExpiresAt');

    expect(field?.description ?? '').toContain('unknown');
  });

  it('#13 igUserId の説明に「ユーザーネームではありません」の趣旨がある', () => {
    // 書かないと、利用者は @ 付きの名前を入れる（実装プラン T1 の注意）。
    const field = publisher().credentialFields.find((item) => item.key === 'igUserId');

    expect(field?.description ?? '').toContain('ユーザーネームではありません');
  });

  it('#14 limits は bodyMaxLength: 2200 / mediaRequired: true / mediaMax: 10 ちょうど', () => {
    expect(publisher().limits).toEqual({ bodyMaxLength: 2200, mediaRequired: true, mediaMax: 10 });
  });

  it('#14 limits のキーは PublisherLimits の部分集合', () => {
    const keys = Object.keys(publisher().limits ?? {});

    for (const key of keys) {
      expect(PUBLISHER_LIMIT_KEYS as readonly string[], key).toContain(key);
    }
  });

  it('#15 登録に manual のキーが無い', () => {
    // `manual: undefined` も書かない。Core が deliveryMode: 'manual' を 422 で断る（設計 §9.3）。
    const registration = publisher();

    expect('manual' in registration).toBe(false);
  });

  it('#15 validate がある', () => {
    expect(typeof publisher().validate).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */
/* caption.ts：ハッシュタグとメンションの数え方（設計 §9.2）                         */
/* -------------------------------------------------------------------------- */

describe('caption.ts の数え方', () => {
  it('#19 半角の # で始まる語を1つずつ数える', () => {
    expect(countHashtags(hashtags(30))).toBe(30);
  });

  it('#19 全角の ＃ も1個に数える', () => {
    expect(countHashtags('＃タグ')).toBe(1);
  });

  it('#20 a#b は数えない', () => {
    expect(countHashtags('a#b')).toBe(0);
  });

  it('#20 &#123; は数えない', () => {
    expect(countHashtags('&#123;')).toBe(0);
  });

  it('#20 https://x.test/#a の #a は数える（多めに数える側に倒す）', () => {
    expect(countHashtags('https://x.test/#a')).toBe(1);
  });

  it('#20 行頭の # は数える', () => {
    expect(countHashtags('一行目\n#二行目')).toBe(1);
  });

  it('#20 # の後に文字が続かなければ数えない', () => {
    expect(countHashtags('# 見出し')).toBe(0);
  });

  it('#21 @ユーザーネーム を1つずつ数える', () => {
    expect(countMentions(mentions(20))).toBe(20);
  });

  it('#21 ユーザーネームに . と _ を含んでも1件', () => {
    expect(countMentions('@tori.fune_jp さん')).toBe(1);
  });

  it('#21 a@b.com は数えない', () => {
    expect(countMentions('a@b.com')).toBe(0);
  });

  it('同じ関数を続けて呼んでも数が変わらない（正規表現の状態を持ち越さない）', () => {
    expect(countHashtags('#a #b')).toBe(2);
    expect(countHashtags('#a #b')).toBe(2);
    expect(countMentions('@a @b')).toBe(2);
    expect(countMentions('@a @b')).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* validate()（#19〜#28）                                                       */
/* -------------------------------------------------------------------------- */

describe('validate()（#19〜#28）', () => {
  it('#19 ハッシュタグ30個は問題なし', () => {
    expect(validate(draft({ body: hashtags(30) }))).toEqual([]);
  });

  it('#19 ハッシュタグ31個は body の問題が1件', () => {
    const problems = validate(draft({ body: hashtags(31) }));

    expect(fieldsOf(problems)).toEqual(['body']);
    expect(problems[0]?.message).toContain('30');
    expect(problems[0]?.message).toContain('31');
  });

  it('#19 全角の ＃ を混ぜても1個に数える（30 ＋ 全角1 → 31）', () => {
    const problems = validate(draft({ body: `${hashtags(30)} ＃全角` }));

    expect(fieldsOf(problems)).toEqual(['body']);
  });

  it('#20 a#b と &#123; を足しても数が増えない（30 → 問題なし）', () => {
    expect(validate(draft({ body: `${hashtags(30)} a#b &#123;` }))).toEqual([]);
  });

  it('#20 https://x.test/#a の #a を数える（30 ＋ 1 → 31）', () => {
    const problems = validate(draft({ body: `${hashtags(30)} https://x.test/#a` }));

    expect(fieldsOf(problems)).toEqual(['body']);
  });

  it('#21 メンション20件は問題なし', () => {
    expect(validate(draft({ body: mentions(20) }))).toEqual([]);
  });

  it('#21 メンション21件は body の問題が1件', () => {
    const problems = validate(draft({ body: mentions(21) }));

    expect(fieldsOf(problems)).toEqual(['body']);
    expect(problems[0]?.message).toContain('20');
    expect(problems[0]?.message).toContain('21');
  });

  it('#21 a@b.com を足しても数が増えない（20 → 問題なし）', () => {
    expect(validate(draft({ body: `${mentions(20)} a@b.com` }))).toEqual([]);
  });

  it('#22 link があれば link の問題', () => {
    const problems = validate(draft({ link: 'https://example.com' }));

    expect(fieldsOf(problems)).toEqual(['link']);
    expect(problems[0]?.message).toContain('リンクにしません');
  });

  it('#22 link が null なら問題なし', () => {
    expect(validate(draft({ link: null }))).toEqual([]);
  });

  it('#22 link が空文字なら問題なし', () => {
    expect(validate(draft({ link: '' }))).toEqual([]);
  });

  it('#23 providerOptions の未知のキーは providerOptions.<key> の問題', () => {
    const problems = validate(draft({ providerOptions: { mystery: 1 } }));

    expect(fieldsOf(problems)).toEqual(['providerOptions.mystery']);
    expect(problems[0]?.message).toContain('mystery');
  });

  it('#23 providerOptions が {} なら問題なし', () => {
    expect(validate(draft({ providerOptions: {} }))).toEqual([]);
  });

  it('#24 本文 2201 文字でも本文の長さの問題を返さない', () => {
    // Core の bodyMaxLength が同じ数え方で正確に効く（設計 §9.2）。
    expect(validate(draft({ body: 'あ'.repeat(2201) }))).toEqual([]);
  });

  it('#24 media が 0 件でも枚数の問題を返さない', () => {
    expect(validate(draft({ media: [] }))).toEqual([]);
  });

  it('#24 media が 11 件でも枚数の問題を返さない', () => {
    const media = Array.from({ length: 11 }, (_, index) => ({
      url: `https://cdn.example.com/${index}.jpg`,
      alt: null,
    }));

    expect(validate(draft({ media }))).toEqual([]);
  });

  it('#25 alt が 5000 文字でも問題を返さない', () => {
    // 送らないので断らない（設計 §6.12）。
    expect(
      validate(
        draft({ media: [{ url: 'https://cdn.example.com/a.jpg', alt: 'あ'.repeat(5000) }] }),
      ),
    ).toEqual([]);
  });

  it('#26 providerOptions が null でも例外を投げない', () => {
    const post = draft({
      providerOptions: null as unknown as SocialPostDraftView['providerOptions'],
    });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#26 providerOptions が配列でも例外を投げない', () => {
    const post = draft({
      providerOptions: ['x'] as unknown as SocialPostDraftView['providerOptions'],
    });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#26 providerOptions が循環参照を含んでも例外を投げない', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const problems = validate(
      draft({ providerOptions: circular as SocialPostDraftView['providerOptions'] }),
    );

    expect(fieldsOf(problems)).toEqual(['providerOptions.self']);
  });

  it('#26 media に null 要素があっても例外を投げない', () => {
    const post = draft({ media: [null] as unknown as SocialPostDraftView['media'] });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#26 media が配列でなくても例外を投げない', () => {
    const post = draft({ media: null as unknown as SocialPostDraftView['media'] });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#26 body が文字列でなくても例外を投げない', () => {
    const post = draft({ body: 123 as unknown as string });

    expect(validate(post)).toEqual([]);
  });

  it('#27 同期で配列を返し、fetch を1度も呼ばない', () => {
    // 同期でなければ validate() の補助関数が投げる。
    validate(draft({ body: hashtags(31), link: 'https://example.com' }));

    expect(fetchCalls).toBe(0);
  });

  it('#28 複数の違反はすべて返る（ハッシュタグ31 ＋ link → 2件）', () => {
    const problems = validate(draft({ body: hashtags(31), link: 'https://example.com' }));

    expect(fieldsOf(problems).sort()).toEqual(['body', 'link']);
  });

  it('#28 ハッシュタグ・メンション・link・providerOptions の違反を全部返す', () => {
    const problems = validate(
      draft({
        body: `${hashtags(31)} ${mentions(21)}`,
        link: 'https://example.com',
        providerOptions: { a: 1 },
      }),
    );

    expect(fieldsOf(problems).sort()).toEqual(['body', 'body', 'link', 'providerOptions.a']);
  });

  it('deliveryMode が manual でも同じ検査をする（deliveryMode で分岐しない）', () => {
    const problems = validate(draft({ deliveryMode: 'manual', link: 'https://example.com' }));

    expect(fieldsOf(problems)).toEqual(['link']);
  });
});

/* -------------------------------------------------------------------------- */
/* token.ts：資格情報の形と期限の判定（設計 §5.2 / §6.2 / §6.7）                     */
/* -------------------------------------------------------------------------- */

describe('token.ts：igUserId の形', () => {
  it('数字だけの ID は通る', () => {
    expect(isValidIgUserId('17841400000000000')).toBe(true);
  });

  it('64 桁は通り、65 桁は通らない', () => {
    expect(isValidIgUserId('1'.repeat(64))).toBe(true);
    expect(isValidIgUserId('1'.repeat(65))).toBe(false);
  });

  it.each(['abc', '1/../2', '1?x=1', '', '@torifune', '１２３', ' 123'])(
    '#49 P0 %j は通らない',
    (value) => {
      expect(isValidIgUserId(value)).toBe(false);
    },
  );

  it('文字列でなければ通らない', () => {
    expect(isValidIgUserId(123 as unknown as string)).toBe(false);
    expect(isValidIgUserId(undefined as unknown as string)).toBe(false);
  });
});

describe('token.ts：accessToken の形', () => {
  it('印字可能な ASCII だけのトークンは通る', () => {
    expect(isValidAccessToken('IGAAbc123-_.~!')).toBe(true);
  });

  it('2048 文字は通り、2049 文字は通らない', () => {
    expect(isValidAccessToken('a'.repeat(2048))).toBe(true);
    expect(isValidAccessToken('a'.repeat(2049))).toBe(false);
  });

  it.each([
    ['改行', 'IGAA\nabc'],
    ['CR', 'IGAA\rabc'],
    ['空白', 'IGAA abc'],
    ['タブ', 'IGAA\tabc'],
    ['全角文字', 'IGAAａbc'],
    ['日本語', 'トークン'],
    ['空文字', ''],
    ['DEL', 'IGAA\u007Fabc'],
  ])('#44 / #49 P0 %s を含むトークンは通らない', (_label, value) => {
    expect(isValidAccessToken(value)).toBe(false);
  });

  it('文字列でなければ通らない', () => {
    expect(isValidAccessToken(null as unknown as string)).toBe(false);
  });
});

describe('token.ts：期限の読み取り（parseExpiry）', () => {
  it('ISO 8601 の期限を読める', () => {
    const expiry = parseExpiry('2026-10-23T12:00:00Z', NOW);

    expect(expiry).toBeInstanceOf(Date);
    expect((expiry as Date).toISOString()).toBe('2026-10-23T12:00:00.000Z');
  });

  it('前後の空白を許す', () => {
    const expiry = parseExpiry('  2026-10-23T12:00:00Z  ', NOW);

    expect((expiry as Date).toISOString()).toBe('2026-10-23T12:00:00.000Z');
  });

  it.each(['unknown', '', '   ', 'あした', 'UNKNOWN'])('#42 %j は unknown', (value) => {
    expect(parseExpiry(value, NOW)).toBe('unknown');
  });

  it('#42 61 日より先（2099-01-01）は unknown（打ち間違いを信じない）', () => {
    expect(parseExpiry('2099-01-01T00:00:00Z', NOW)).toBe('unknown');
  });

  it('ちょうど 61 日後は読める', () => {
    const value = daysFromNow(61).toISOString();

    expect(parseExpiry(value, NOW)).toBeInstanceOf(Date);
  });

  it('61 日後を 1 秒でも過ぎたら unknown', () => {
    const value = daysFromNow(61, 1000).toISOString();

    expect(parseExpiry(value, NOW)).toBe('unknown');
  });

  it('過ぎた期限は読める（延長の判定に回す）', () => {
    const value = daysFromNow(-1).toISOString();

    expect(parseExpiry(value, NOW)).toBeInstanceOf(Date);
  });

  it('文字列でなければ unknown', () => {
    expect(parseExpiry(undefined as unknown as string, NOW)).toBe('unknown');
  });
});

describe('token.ts：延長の要否（shouldRefresh）', () => {
  it('#40 残り 29 日なら延長する', () => {
    expect(shouldRefresh(daysFromNow(29), NOW)).toBe(true);
  });

  it('#41 残り 31 日なら延長しない', () => {
    expect(shouldRefresh(daysFromNow(31), NOW)).toBe(false);
  });

  it('残りちょうど 30 日なら延長しない（30 日を「切って」いない）', () => {
    expect(shouldRefresh(daysFromNow(30), NOW)).toBe(false);
  });

  it('残り 30 日を 1 秒切ったら延長する', () => {
    expect(shouldRefresh(daysFromNow(30, -1000), NOW)).toBe(true);
  });

  it('#42 unknown なら延長する', () => {
    expect(shouldRefresh('unknown', NOW)).toBe(true);
  });

  it('過ぎた期限なら延長を試みる', () => {
    expect(shouldRefresh(daysFromNow(-1), NOW)).toBe(true);
  });

  it('#40 / #41 / #42 parseExpiry と組み合わせた判定', () => {
    expect(shouldRefresh(parseExpiry(daysFromNow(29).toISOString(), NOW), NOW)).toBe(true);
    expect(shouldRefresh(parseExpiry(daysFromNow(31).toISOString(), NOW), NOW)).toBe(false);
    expect(shouldRefresh(parseExpiry('2099-01-01T00:00:00Z', NOW), NOW)).toBe(true);
    expect(shouldRefresh(parseExpiry('あした', NOW), NOW)).toBe(true);
  });

  it('閾値は 30 日、最長の寿命は 61 日', () => {
    expect(TOKEN_REFRESH_THRESHOLD_MS).toBe(30 * DAY_MS);
    expect(TOKEN_MAX_LIFETIME_MS).toBe(61 * DAY_MS);
  });
});

describe('token.ts：expires_in から期限を作る（expiryFromExpiresIn）', () => {
  it('#40 60 日（5184000 秒）なら now ＋ 60 日の ISO 文字列', () => {
    expect(expiryFromExpiresIn(5_184_000, NOW)).toBe(daysFromNow(60).toISOString());
  });

  it('ちょうど 61 日なら ISO 文字列', () => {
    expect(expiryFromExpiresIn(61 * 24 * 60 * 60, NOW)).toBe(daysFromNow(61).toISOString());
  });

  it.each([
    ['無い', undefined],
    ['null', null],
    ['負', -1],
    ['0', 0],
    ['小数', 1.5],
    ['文字列', '5184000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['61 日を超える', 61 * 24 * 60 * 60 + 1],
  ])('#45 expires_in が %s なら unknown', (_label, value) => {
    expect(expiryFromExpiresIn(value, NOW)).toBe('unknown');
  });

  it('作った期限は parseExpiry で読み戻せる', () => {
    const value = expiryFromExpiresIn(5_184_000, NOW);

    expect(parseExpiry(value, NOW)).toBeInstanceOf(Date);
  });
});

/* -------------------------------------------------------------------------- */
/* graph.ts の純関数部分（設計 §6.1 / §6.8 / §6.9 / §6.10 / §6.11 / §6.5 / §6.6）       */
/* -------------------------------------------------------------------------- */

describe('graph.ts：宛先と版', () => {
  it('#10 宛先は https://graph.instagram.com の定数', () => {
    expect(GRAPH_API_BASE_URL).toBe('https://graph.instagram.com');
  });

  it('#10 GRAPH_API_VERSION は v＋数字＋.＋数字', () => {
    expect(GRAPH_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });
});

describe('graph.ts：制限時間の定数（設計 §6.8）', () => {
  it.each([
    ['PUBLISH_TOTAL_BUDGET_MS', PUBLISH_TOTAL_BUDGET_MS, 25_000],
    ['PREPARE_BUDGET_MS', PREPARE_BUDGET_MS, 15_000],
    ['CREATE_CONTAINER_TIMEOUT_MS', CREATE_CONTAINER_TIMEOUT_MS, 10_000],
    ['STATUS_TIMEOUT_MS', STATUS_TIMEOUT_MS, 5_000],
    ['POLL_INTERVAL_MS', POLL_INTERVAL_MS, 1_000],
    ['POLL_MAX_ROUNDS', POLL_MAX_ROUNDS, 10],
    ['MEDIA_PUBLISH_TIMEOUT_MS', MEDIA_PUBLISH_TIMEOUT_MS, 10_000],
    ['PERMALINK_TIMEOUT_MS', PERMALINK_TIMEOUT_MS, 3_000],
    ['REFRESH_TIMEOUT_MS', REFRESH_TIMEOUT_MS, 3_000],
    ['CAROUSEL_CHILD_CONCURRENCY', CAROUSEL_CHILD_CONCURRENCY, 5],
  ])('%s は %s（設計の値 %s）', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('準備の期限は 合計 − 公開の制限時間', () => {
    expect(PREPARE_BUDGET_MS).toBe(PUBLISH_TOTAL_BUDGET_MS - MEDIA_PUBLISH_TIMEOUT_MS);
  });
});

describe('graph.ts：エラーの分類（classifyGraphError。設計 §6.9）', () => {
  function body(error: Record<string, unknown>): unknown {
    return { error };
  }

  it('HTTP 429 は rateLimit', () => {
    expect(classifyGraphError(429, {})).toBe('rateLimit');
  });

  it.each([4, 17, 32, 613])('code %s は rateLimit', (code) => {
    expect(classifyGraphError(400, body({ code }))).toBe('rateLimit');
  });

  it('code 190 は token', () => {
    expect(classifyGraphError(400, body({ code: 190 }))).toBe('token');
  });

  it.each([10, 200, 250, 299])('code %s は permission', (code) => {
    expect(classifyGraphError(403, body({ code }))).toBe('permission');
  });

  it('code 300 は permission ではない', () => {
    expect(classifyGraphError(400, body({ code: 300 }))).toBe('other');
  });

  it('error_subcode 2207042 は dailyLimit', () => {
    expect(classifyGraphError(400, body({ code: 9, error_subcode: 2207042 }))).toBe('dailyLimit');
  });

  it('rateLimit の code と subcode 2207042 が重なったら dailyLimit（直らない側へ倒す）', () => {
    // 実装プラン T5 の注意 / §8 の 9。
    expect(classifyGraphError(400, body({ code: 4, error_subcode: 2207042 }))).toBe('dailyLimit');
    expect(classifyGraphError(429, body({ code: 4, error_subcode: 2207042 }))).toBe('dailyLimit');
  });

  it('is_transient: true は transient', () => {
    expect(classifyGraphError(400, body({ code: 100, is_transient: true }))).toBe('transient');
  });

  it('is_transient が真偽値の true でなければ transient ではない', () => {
    expect(classifyGraphError(400, body({ code: 100, is_transient: 'true' }))).toBe('other');
    expect(classifyGraphError(400, body({ code: 100, is_transient: 1 }))).toBe('other');
  });

  it('code 100（is_transient なし）は other', () => {
    expect(classifyGraphError(400, body({ code: 100 }))).toBe('other');
  });

  it('数値でない code（"190" の文字列）は token にしない', () => {
    // 数値に直さない（実装プラン T16 の注意）。
    expect(classifyGraphError(400, body({ code: '190' }))).toBe('other');
  });

  it('数値でない code（"4" の文字列）は rateLimit にしない', () => {
    expect(classifyGraphError(400, body({ code: '4' }))).toBe('other');
  });

  it('数値でない error_subcode（"2207042" の文字列）は dailyLimit にしない', () => {
    expect(classifyGraphError(400, body({ code: 9, error_subcode: '2207042' }))).toBe('other');
  });

  it.each([
    ['null', null],
    ['文字列', '<html>'],
    ['配列', []],
    ['error が無い', {}],
    ['error が文字列', { error: 'x' }],
    ['error が null', { error: null }],
  ])('本体が %s なら other（例外を投げない）', (_label, value) => {
    expect(classifyGraphError(400, value)).toBe('other');
  });

  it('500 で本体が読めなくても other', () => {
    expect(classifyGraphError(500, undefined)).toBe('other');
  });
});

describe('graph.ts：reason に出してよい code / error_subcode（設計 §6.11）', () => {
  it.each([1, 2, 4, 9, 10, 17, 24, 25, 32, 100, 190, 200, 250, 299, 368, 613])(
    '既知の code の集合に %s がある',
    (code) => {
      expect(KNOWN_GRAPH_ERROR_CODES.has(code)).toBe(true);
    },
  );

  it('既知の error_subcode の集合に 2207042 がある', () => {
    expect(KNOWN_GRAPH_ERROR_SUBCODES.has(2207042)).toBe(true);
  });

  it('既知の code はそのまま文字列で書く', () => {
    expect(describeGraphCode(190)).toBe('190');
    expect(describeGraphCode(250)).toBe('250');
  });

  it('既知の error_subcode はそのまま文字列で書く', () => {
    expect(describeGraphSubcode(2207042)).toBe('2207042');
  });

  it.each([
    ['知らない数値', 987654],
    ['数値でない "190"', '190'],
    ['<script>', '<script>'],
    ['無い', undefined],
    ['null', null],
    ['小数', 190.5],
    ['NaN', Number.NaN],
  ])('#59 code が %s なら unknown', (_label, value) => {
    expect(describeGraphCode(value)).toBe('unknown');
  });

  it.each([
    ['知らない数値', 1234567],
    ['数値でない "2207042"', '2207042'],
    ['<script>', '<script>'],
    ['無い', undefined],
  ])('#59 error_subcode が %s なら unknown', (_label, value) => {
    expect(describeGraphSubcode(value)).toBe('unknown');
  });
});

describe('graph.ts：retryAfterMsFrom（設計 §6.10）', () => {
  function usage(values: readonly unknown[]): string {
    return JSON.stringify({
      '17841400000000000': values.map((value) => ({
        type: 'instagram',
        call_count: 100,
        estimated_time_to_regain_access: value,
      })),
    });
  }

  it('#54 Retry-After: 30 → 30000', () => {
    expect(retryAfterMsFrom(new Headers({ 'Retry-After': '30' }))).toBe(30_000);
  });

  it('#54 X-Business-Use-Case-Usage の estimated_time_to_regain_access: 7（分）→ 420000', () => {
    expect(retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': usage([7]) }))).toBe(
      420_000,
    );
  });

  it('#54 両方あれば Retry-After を先に見る', () => {
    const headers = new Headers({
      'Retry-After': '30',
      'X-Business-Use-Case-Usage': usage([7]),
    });

    expect(retryAfterMsFrom(headers)).toBe(30_000);
  });

  it('X-Business-Use-Case-Usage に複数あれば最大値', () => {
    expect(retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': usage([3, 12, 7]) }))).toBe(
      720_000,
    );
  });

  it('Retry-After が読めなければ X-Business-Use-Case-Usage を見る', () => {
    const headers = new Headers({
      'Retry-After': 'abc',
      'X-Business-Use-Case-Usage': usage([7]),
    });

    expect(retryAfterMsFrom(headers)).toBe(420_000);
  });

  it('#54 ヘッダが無ければ付けない', () => {
    expect(retryAfterMsFrom(new Headers())).toBeUndefined();
  });

  it('#54 壊れた JSON なら付けない', () => {
    expect(
      retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': '{"a":[{' })),
    ).toBeUndefined();
  });

  it('#54 負の値なら付けない', () => {
    expect(retryAfterMsFrom(new Headers({ 'Retry-After': '-5' }))).toBeUndefined();
    expect(
      retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': usage([-7]) })),
    ).toBeUndefined();
  });

  it('0 なら付けない（正の数でない）', () => {
    expect(retryAfterMsFrom(new Headers({ 'Retry-After': '0' }))).toBeUndefined();
    expect(
      retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': usage([0]) })),
    ).toBeUndefined();
  });

  it('数値でない estimated_time_to_regain_access は付けない', () => {
    expect(
      retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': usage(['7']) })),
    ).toBeUndefined();
  });

  it('#54 5000 文字のヘッダなら付けない', () => {
    const long = `${'1'.repeat(4999)}0`;

    expect(retryAfterMsFrom(new Headers({ 'Retry-After': long }))).toBeUndefined();
    const padded = JSON.stringify({
      pad: 'x'.repeat(5000),
      a: [{ estimated_time_to_regain_access: 7 }],
    });
    expect(retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': padded }))).toBeUndefined();
  });

  it('JSON の形が違っても例外を投げない', () => {
    for (const value of ['null', '1', '"x"', '[]', '{"a":1}', '{"a":[null,1,"x"]}']) {
      expect(
        retryAfterMsFrom(new Headers({ 'X-Business-Use-Case-Usage': value })),
        value,
      ).toBeUndefined();
    }
  });
});

describe('graph.ts：Graph API が返した ID の形（isValidGraphId。設計 §6.2 / §6.5）', () => {
  it('数字だけの ID は通る', () => {
    expect(isValidGraphId('17895695668004550')).toBe(true);
  });

  it('#76 64 桁は通る', () => {
    expect(isValidGraphId('9'.repeat(64))).toBe(true);
  });

  it('#74 65 桁以上（200 桁）は通らない', () => {
    expect(isValidGraphId('9'.repeat(65))).toBe(false);
    expect(isValidGraphId('9'.repeat(200))).toBe(false);
  });

  it.each(['123/../456', 'x/y', '', '12a', '1?x=1', ' 1'])('#75 %j は通らない', (value) => {
    expect(isValidGraphId(value)).toBe(false);
  });

  it('文字列でなければ通らない（数値の ID も含む）', () => {
    expect(isValidGraphId(123)).toBe(false);
    expect(isValidGraphId(null)).toBe(false);
    expect(isValidGraphId(undefined)).toBe(false);
  });
});

describe('graph.ts：permalink の検査（isAcceptablePermalink。設計 §6.6）', () => {
  const PREFIX = 'https://www.instagram.com/p/';

  it('#79 https://www.instagram.com/p/AbC/ は通る', () => {
    expect(isAcceptablePermalink('https://www.instagram.com/p/AbC/')).toBe(true);
  });

  it('https://instagram.com/p/AbC/ は通る', () => {
    expect(isAcceptablePermalink('https://instagram.com/p/AbC/')).toBe(true);
  });

  it('#77 2048 文字ちょうどは通る', () => {
    const value = PREFIX + 'a'.repeat(2048 - PREFIX.length);

    expect(value).toHaveLength(2048);
    expect(isAcceptablePermalink(value)).toBe(true);
  });

  it('#77 2049 文字は通らない', () => {
    const value = PREFIX + 'a'.repeat(2049 - PREFIX.length);

    expect(isAcceptablePermalink(value)).toBe(false);
  });

  it.each([
    'http://www.instagram.com/p/x/',
    'https://evil.test/p/x/',
    'https://user:pw@www.instagram.com/p/x/',
    'https://user@www.instagram.com/p/x/',
    'https://instagram.com.evil.test/',
    'https://evilinstagram.com/p/x/',
    'not a url',
    '',
    'javascript:alert(1)',
  ])('#78 %j は通らない', (value) => {
    expect(isAcceptablePermalink(value)).toBe(false);
  });

  it('文字列でなければ通らない', () => {
    expect(isAcceptablePermalink(undefined)).toBe(false);
    expect(isAcceptablePermalink(42)).toBe(false);
  });
});

describe('graph.ts：fbtrace_id の形（isValidFbtraceId。設計 §6.11）', () => {
  it('#62 英数字・_・- だけなら通る', () => {
    expect(isValidFbtraceId('AbC_1-x')).toBe(true);
  });

  it('#62 64 文字は通り、65 文字は通らない', () => {
    expect(isValidFbtraceId('a'.repeat(64))).toBe(true);
    expect(isValidFbtraceId('a'.repeat(65))).toBe(false);
  });

  it.each(['a b', '', 'a/b', 'a\nb'])('#62 %j は通らない', (value) => {
    expect(isValidFbtraceId(value)).toBe(false);
  });

  it('文字列でなければ通らない', () => {
    expect(isValidFbtraceId(1)).toBe(false);
  });
});
