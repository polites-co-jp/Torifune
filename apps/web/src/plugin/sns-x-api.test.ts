import type {
  PublisherRegistration,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL, toResponse, tweetCreated } from '@/test-support/x-api';
import { createXApiPublisher } from '../../../../plugins/sns-x-api/social';
import * as apiText from '../../../../plugins/sns-x-api/x-text';
import { createXManualPublisher } from '../../../../plugins/sns-x-manual/social';
import * as manualText from '../../../../plugins/sns-x-manual/x-text';

/**
 * X 配信 Plugin（有料版・`sns-x-api`）の登録・`validate()`・`manual()` の単体検査（037-sns-x 設計 §10.5）と、
 * **2 つの Plugin の振る舞いの一致**（#10）。
 *
 * `publish()` はこのファイルでは呼ばない（`sns-x-api-publish.test.ts` が見る）。
 * #10 のうち「R3 に送る `text` と intent URL の `text` の一致」は `publish()` の正常系（実装プラン T11）で足す。
 *
 * 担当する受け入れ条件：#10（`manual()` / `validate()` の一致）、#26（`publish` がある、を除く）、#29、#30。
 *
 * #89：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

const LINK = 'https://example.com/a';

/** ZWJ で繋いだ絵文字（4 人家族）。 */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

const INTENT_PREFIX = 'https://x.com/intent/tweet?text=';
const URL_HEAD = 'https://example.com/';

/** intent URL の全長がちょうど `target` 文字になる本文（URL 1 本だけ。重みは 23）。 */
function bodyWithIntentLength(target: number): string {
  const fixed = INTENT_PREFIX.length + encodeURIComponent(URL_HEAD).length;
  return URL_HEAD + 'a'.repeat(target - fixed);
}

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'x',
    displayName: 'とりふね',
    handle: 'torifune_example',
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
let fetchCalls = 0;

/** 呼ばれたら投げる `fetch`（#89）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    fetchCalls += 1;
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = throwingFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Registration = PublisherRegistration;

/** 本番と同じく**引数を与えずに**作る（設計 §10.1 の 1）。 */
function apiPublisher(): Registration {
  return createXApiPublisher();
}

function manualPublisher(): Registration {
  return createXManualPublisher();
}

/** `validate()` を同期で呼ぶ（#29：Promise を返したらここで落ちる）。 */
function validateWith(
  registration: Registration,
  post: SocialPostDraftView,
  account: SocialAccountView = accountView(),
): readonly PublisherValidationProblem[] {
  if (registration.validate === undefined) {
    throw new Error('validate() が実装されていない');
  }
  const result = registration.validate({ post, account });
  if (!Array.isArray(result)) {
    throw new Error('validate() が同期で配列を返していない');
  }
  return result;
}

/** `manual()` を同期で呼ぶ（#30：Promise を返したらここで落ちる）。 */
function manualWith(
  registration: Registration,
  post: SocialPostView,
  account: SocialAccountView = accountView(),
) {
  if (registration.manual === undefined) {
    throw new Error('manual() が実装されていない');
  }
  const result = registration.manual({ post, account });
  if (result instanceof Promise) {
    throw new Error('manual() が同期で返していない');
  }
  return result;
}

function validate(post: SocialPostDraftView): readonly PublisherValidationProblem[] {
  return validateWith(apiPublisher(), post);
}

function fieldsOf(problems: readonly PublisherValidationProblem[]): string[] {
  return problems.map((problem) => problem.field);
}

/* -------------------------------------------------------------------------- */
/* 登録（#26）                                                                  */
/* -------------------------------------------------------------------------- */

describe('登録（#26）', () => {
  it('#26 provider が x で、label が X', () => {
    const registration = apiPublisher();

    expect(registration.provider).toBe('x');
    expect(registration.label).toBe('X');
  });

  it('#26 資格情報の項目は apiKey / apiKeySecret / accessToken / accessTokenSecret の 4 つちょうど', () => {
    // **後から足せない**（設計 §5.2）。OAuth 1.0a の 4 値で確定させる。
    expect(apiPublisher().credentialFields.map((field) => field.key)).toEqual([
      'apiKey',
      'apiKeySecret',
      'accessToken',
      'accessTokenSecret',
    ]);
  });

  it('#26 kind は text / secret / text / secret', () => {
    expect(apiPublisher().credentialFields.map((field) => field.kind)).toEqual([
      'text',
      'secret',
      'text',
      'secret',
    ]);
  });

  it('#26 accessToken の説明に「Read and write」が現れる', () => {
    // 読み取り専用のまま発行したトークンでは投稿が 403 で落ちる（設計 §5.1）。
    const field = apiPublisher().credentialFields.find((item) => item.key === 'accessToken');

    expect(field?.description ?? '').toContain('Read and write');
  });

  it('#26 limits は { mediaMax: 4 } ちょうど', () => {
    expect(apiPublisher().limits).toEqual({ mediaMax: 4 });
  });

  it('#26 limits に bodyMaxLength が無い', () => {
    // URL は長さによらず 23 と数えるので、String.length に対して必ず緩い有限値が無い（設計 §9.1）。
    expect('bodyMaxLength' in (apiPublisher().limits ?? {})).toBe(false);
  });

  it('#26 validate と manual がある', () => {
    const registration = apiPublisher();

    expect(typeof registration.validate).toBe('function');
    expect(typeof registration.manual).toBe('function');
  });

  it('#26 publish がある', () => {
    expect(typeof apiPublisher().publish).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */
/* validate()（#29）                                                            */
/* -------------------------------------------------------------------------- */

describe('validate()（#29）', () => {
  it('#29 deliveryMode: auto を断らない', () => {
    // 有料版は自動配信できる。auto を断るのは sns-x-manual だけ（設計 §9.2 の 1）。
    expect(validate(draft({ deliveryMode: 'auto' }))).toEqual([]);
  });

  it('#29 deliveryMode: manual も通る', () => {
    expect(validate(draft({ deliveryMode: 'manual', link: LINK }))).toEqual([]);
  });

  it('#29 auto で本文の重み 281 なら body の問題だけ', () => {
    expect(fieldsOf(validate(draft({ deliveryMode: 'auto', body: 'a'.repeat(281) })))).toEqual([
      'body',
    ]);
  });

  it('#29 auto では intent URL の長さを問題にしない', () => {
    // 自動配信は intent URL を作らない（設計 §9.2 の 3 は manual だけ）。
    expect(validate(draft({ deliveryMode: 'auto', body: bodyWithIntentLength(2049) }))).toEqual([]);
  });

  it('#29 manual で intent URL が 2049 文字なら body の問題', () => {
    expect(
      fieldsOf(validate(draft({ deliveryMode: 'manual', body: bodyWithIntentLength(2049) }))),
    ).toEqual(['body']);
  });

  it('#29 auto の投稿でも body の問題は x-text.ts の checkXText の結果そのもの', () => {
    // 本文について言うことは必ず checkXText から来る（設計 §4.2 / §9.2）。
    for (const post of [
      draft({ body: 'a'.repeat(281) }),
      draft({ body: 'a'.repeat(257), link: LINK }),
      draft({ body: bodyWithIntentLength(2049) }),
      draft({ body: 'こんにちは' }),
    ]) {
      const bodyProblems = validate(post).filter((problem) => problem.field === 'body');

      expect(bodyProblems).toEqual(apiText.checkXText(post));
    }
  });

  it('#29 providerOptions.replyTo を断る（#24 と同じ扱い）', () => {
    const problems = validate(draft({ providerOptions: { replyTo: '1' } }));

    expect(fieldsOf(problems)).toEqual(['providerOptions.replyTo']);
    expect(problems[0]?.message ?? '').toContain('replyTo');
  });

  it('#29 providerOptions の判定が sns-x-manual と同じ', () => {
    const circular: Record<string, unknown> = { replyTo: '1' };
    circular['self'] = circular;
    for (const providerOptions of [{ replyTo: '1' }, { replyTo: '1', quote: '2' }, circular, {}]) {
      const post = draft({ deliveryMode: 'manual', providerOptions });

      expect(validateWith(apiPublisher(), post)).toEqual(validateWith(manualPublisher(), post));
    }
  });

  it('#29 providerOptions が null でも例外を投げない', () => {
    const post = draft({
      providerOptions: null as unknown as Readonly<Record<string, unknown>>,
    });

    expect(() => validate(post)).not.toThrow();
  });

  it('#29 providerOptions が配列でも例外を投げない', () => {
    const post = draft({
      providerOptions: ['replyTo'] as unknown as Readonly<Record<string, unknown>>,
    });

    expect(() => validate(post)).not.toThrow();
  });

  it('#29 providerOptions が循環参照を含んでも例外を投げない', () => {
    const circular: Record<string, unknown> = { replyTo: '1' };
    circular['self'] = circular;

    expect(() => validate(draft({ providerOptions: circular }))).not.toThrow();
  });

  it('#29 同期で返り、fetch を呼ばない', () => {
    const result = apiPublisher().validate?.({ post: draft(), account: accountView() });

    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
    expect(fetchCalls).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* manual()（#30）                                                              */
/* -------------------------------------------------------------------------- */

describe('manual()（#30）', () => {
  it('#30 sns-x-manual の manual() と同じ値を返す', () => {
    const post = postView({ body: '本文です', link: LINK });

    expect(manualWith(apiPublisher(), post)).toEqual(manualWith(manualPublisher(), post));
  });

  it('#30 { url: buildXIntentUrl(post), note: X_MANUAL_NOTE } を返す', () => {
    const post = postView({ body: '本文です', link: LINK });

    expect(manualWith(apiPublisher(), post)).toEqual({
      url: apiText.buildXIntentUrl(post),
      note: apiText.X_MANUAL_NOTE,
    });
  });

  it('#30 同期で返り、fetch を呼ばない', () => {
    const result = apiPublisher().manual?.({ post: postView(), account: accountView() });

    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
    expect(fetchCalls).toBe(0);
  });

  it('#30 account の値を変えても戻り値が変わらない', () => {
    const post = postView({ body: '本文です', link: LINK });
    const other = accountView({
      id: '0199aaaa-0000-7000-8000-00000000a999',
      displayName: '別のアカウント',
      handle: 'another_handle',
      credentialConfigured: false,
    });

    expect(manualWith(apiPublisher(), post, other)).toEqual(manualWith(apiPublisher(), post));
  });
});

/* -------------------------------------------------------------------------- */
/* 振る舞いの一致（#10）                                                         */
/* -------------------------------------------------------------------------- */

interface Pair {
  readonly label: string;
  readonly body: unknown;
  readonly link: unknown;
}

/**
 * #10 の本文・`link` の組（設計 §10.2 の #10 が挙げる種類をすべて含む）。
 * いずれも `deliveryMode: 'manual'` の投稿として 2 つの publisher に渡す。
 */
const PAIRS: readonly Pair[] = [
  { label: '空の本文', body: '', link: null },
  { label: '日本語', body: 'こんにちは、とりふね', link: null },
  { label: '日本語 ＋ link', body: 'お知らせです', link: 'https://example.com/news' },
  { label: '絵文字', body: '今日も👍🎉', link: null },
  { label: 'ZWJ で繋いだ絵文字', body: `家族 ${FAMILY}`, link: null },
  { label: '国旗', body: '🇯🇵 から', link: null },
  {
    label: 'URL を含む',
    body: '詳しくは https://example.com/a?x=1&y=2 を見てください',
    link: null,
  },
  { label: '末尾の「。」つきの URL', body: '見て https://example.com/x。', link: null },
  { label: '& # + %', body: 'A&B #tag 1+1 100%', link: null },
  { label: '改行', body: '一行目\n二行目\r\n三行目', link: LINK },
  { label: '重み 280 ちょうど（半角）', body: 'a'.repeat(280), link: null },
  { label: '重み 281（半角）', body: 'a'.repeat(281), link: null },
  { label: '重み 280 ちょうど（日本語）', body: 'あ'.repeat(140), link: null },
  { label: '重み 282（日本語）', body: 'あ'.repeat(141), link: null },
  { label: 'link 込みで 280', body: 'a'.repeat(256), link: LINK },
  { label: 'link 込みで 281', body: 'a'.repeat(257), link: LINK },
  {
    label: '長い URL で intent URL が 2048 を超える',
    body: bodyWithIntentLength(2060),
    link: null,
  },
  { label: 'intent URL が 2048 ちょうど', body: bodyWithIntentLength(2048), link: null },
  { label: 'intent URL が 2049', body: bodyWithIntentLength(2049), link: null },
  {
    label: '長い link で intent URL が 2048 を超える',
    body: '見て',
    link: `https://example.com/${'b'.repeat(2100)}`,
  },
  { label: 'ZWJ で繋いだ絵文字×140', body: FAMILY.repeat(140), link: null },
  { label: '全角記号と半角カナ', body: '\u2014\u2026\u2033\uFF71', link: null },
  { label: '分解された é', body: 'Cafe\u0301', link: null },
  { label: 'body が文字列でない', body: 123, link: null },
  { label: 'link が文字列でない', body: '本文です', link: 42 },
];

/**
 * #10 の組のうち、`publish()` が R3 まで進むもの（本文が空でない文字列で、`auto` の本文の判定に通るもの）。
 * `publish()` は入口で本文の重みを見て、通らなければ外へ出さない（設計 §6.8 の P0）。
 */
const PUBLISHABLE_PAIRS: readonly Pair[] = PAIRS.filter(
  (pair) =>
    typeof pair.body === 'string' &&
    pair.body !== '' &&
    apiText.checkXText({ body: pair.body, link: pair.link, deliveryMode: 'auto' }).length === 0,
);

function draftOf(pair: Pair): SocialPostDraftView {
  return draft({
    deliveryMode: 'manual',
    body: pair.body as string,
    link: pair.link as string | null,
  });
}

function postOf(pair: Pair): SocialPostView {
  return postView({
    deliveryMode: 'manual',
    body: pair.body as string,
    link: pair.link as string | null,
  });
}

describe('振る舞いの一致（#10）', () => {
  it('#10 組が 20 通り以上ある', () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(20);
  });

  it('#10 publish() まで通す組が 10 通り以上ある（link あり・URL・絵文字・改行を含む）', () => {
    expect(PUBLISHABLE_PAIRS.length).toBeGreaterThanOrEqual(10);
    expect(PUBLISHABLE_PAIRS.some((pair) => typeof pair.link === 'string')).toBe(true);
    expect(PUBLISHABLE_PAIRS.some((pair) => String(pair.body).includes('https://'))).toBe(true);
    expect(PUBLISHABLE_PAIRS.some((pair) => String(pair.body).includes('\n'))).toBe(true);
  });

  it('#10 組には validate() が問題を返すものと返さないものの両方がある（一致の検査が空振りしない）', () => {
    const results = PAIRS.map((pair) => validateWith(manualPublisher(), draftOf(pair)));

    expect(results.some((problems) => problems.length === 0)).toBe(true);
    expect(results.some((problems) => problems.length > 0)).toBe(true);
  });

  it.each(PAIRS)('#10 2 つの manual() の戻り値が一致する：$label', (pair) => {
    const post = postOf(pair);

    expect(manualWith(apiPublisher(), post)).toEqual(manualWith(manualPublisher(), post));
  });

  it.each(PAIRS)('#10 2 つの validate() の戻り値が一致する：$label', (pair) => {
    const post = draftOf(pair);

    expect(validateWith(apiPublisher(), post)).toEqual(validateWith(manualPublisher(), post));
  });

  it.each(PUBLISHABLE_PAIRS)(
    '#10 publish() が R3 に送る text が、同じ投稿の manual() の URL の text 引数と一致する：$label',
    async (pair) => {
      const post = postView({
        ...postOf(pair),
        deliveryMode: 'auto',
        status: 'publishing',
      });
      const sent: unknown[] = [];
      // 偽の X API（R3 だけ）。**外へは出ない**（`createXApiPublisher` の `fetch` に注入する。設計 §10.1）。
      const fakeX = (async (input: unknown, init: RequestInit = {}): Promise<Response> => {
        if (String(input) !== 'https://api.x.com/2/tweets') {
          throw new TypeError(`偽の X API が知らない宛先: ${String(input)}`);
        }
        const request = new Request(String(input), {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body ?? null,
        });
        sent.push((JSON.parse(await request.text()) as { readonly text?: unknown }).text);
        return toResponse(tweetCreated(), init.signal);
      }) as typeof globalThis.fetch;
      const publish = createXApiPublisher({
        fetch: fakeX,
        now: () => new Date('2026-09-23T12:00:00.000Z'),
        nonce: () => 'nonce-0001',
      }).publish;
      if (publish === undefined) {
        throw new Error('publish() が実装されていない');
      }

      const result = await publish({
        post,
        account: accountView(),
        credential: { ...CREDENTIAL },
        attempt: 1,
        signal: new AbortController().signal,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      expect(result.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe(new URL(manualWith(apiPublisher(), post).url).searchParams.get('text'));
    },
  );

  it.each(PAIRS)(
    '#10 どちらの validate() も body の問題は自分の x-text.ts の checkXText と同じ：$label',
    (pair) => {
      const post = draftOf(pair);
      const bodyOf = (problems: readonly PublisherValidationProblem[]) =>
        problems.filter((problem) => problem.field === 'body');

      expect(bodyOf(validateWith(manualPublisher(), post))).toEqual(manualText.checkXText(post));
      expect(bodyOf(validateWith(apiPublisher(), post))).toEqual(apiText.checkXText(post));
    },
  );
});

/* -------------------------------------------------------------------------- */
/* 対になっていないサロゲート（#93）                                              */
/* -------------------------------------------------------------------------- */

/** 対になっていないサロゲートを含む本文（設計 §9.4 / §10.16）。 */
const LONE_SURROGATES: readonly {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
}[] = [
  { label: '先頭の U+D800', body: '\ud800abc', link: null },
  { label: '末尾の U+DC00', body: 'abc\udc00', link: null },
  { label: '並びの途中の U+D800', body: 'ab\ud800cd', link: null },
  { label: 'link の直前の U+D800', body: 'abc\ud800', link: LINK },
];

describe('対になっていないサロゲート（#93）', () => {
  it.each(LONE_SURROGATES)(
    '#93 validate() は manual でも auto でも例外を投げず body の問題だけを返す：$label',
    (row) => {
      for (const deliveryMode of ['manual', 'auto'] as const) {
        const post = draft({ deliveryMode, body: row.body, link: row.link });

        expect(() => validate(post), deliveryMode).not.toThrow();
        expect(fieldsOf(validate(post)), deliveryMode).toEqual(['body']);
      }
    },
  );

  it.each(LONE_SURROGATES)(
    '#93 validate() の判定が sns-x-manual と一致する（manual）：$label',
    (row) => {
      const post = draft({ deliveryMode: 'manual', body: row.body, link: row.link });

      expect(validateWith(apiPublisher(), post)).toEqual(validateWith(manualPublisher(), post));
    },
  );

  it('#93 正しいサロゲートの対（👍）は body の問題にしない', () => {
    for (const deliveryMode of ['manual', 'auto'] as const) {
      expect(validate(draft({ deliveryMode, body: 'いいね\ud83d\udc4d' })), deliveryMode).toEqual(
        [],
      );
    }
  });

  it.each(LONE_SURROGATES)(
    '#93 manual() も例外を投げず、sns-x-manual の manual() と同じ値を返す：$label',
    (row) => {
      const post = postView({ body: row.body, link: row.link });

      expect(() => manualWith(apiPublisher(), post)).not.toThrow();
      expect(manualWith(apiPublisher(), post)).toEqual(manualWith(manualPublisher(), post));
    },
  );
});
