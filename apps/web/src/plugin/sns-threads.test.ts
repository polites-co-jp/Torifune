import type {
  PublisherLimits,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidManualUrl } from '@/domain/social/social';
import { createThreadsPublisher } from '../../../../plugins/sns-threads/social';
import {
  THREADS_MANUAL_NOTE,
  buildThreadsIntentUrl,
  checkThreadsText,
} from '../../../../plugins/sns-threads/threads-text';
import {
  TOKEN_MAX_LIFETIME_MS,
  TOKEN_REFRESH_THRESHOLD_MS,
  expiryFromExpiresIn,
  isValidAccessToken,
  isValidThreadsUserId,
  parseExpiry,
  shouldRefresh,
} from '../../../../plugins/sns-threads/token';

/**
 * Threads 配信 Plugin の単体検査（040-sns-threads 設計 §5.1 / §5.2 / §9.1 / §9.2 / §9.5 / §10.3 / §10.5 / §10.6）。
 *
 * **実際の Threads を叩かない。** このファイルが見るのは
 * 登録の形（#14〜#17）・`validate()`（#30〜#38）・`manual()`（#40〜#43）・`token.ts` の純関数だけで、
 * どれも外部 I/O を持たない。`publish()` は `sns-threads-publish.test.ts` / `sns-threads-retry.test.ts` が見る。
 *
 * #107：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

/** `PublisherLimits` が持つキー（型からは実行時に取れないので列挙する）。 */
const PUBLISHER_LIMIT_KEYS = [
  'bodyMaxLength',
  'mediaRequired',
  'mediaMax',
] as const satisfies readonly (keyof PublisherLimits)[];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 期限の判定の基準にする「いま」。 */
const NOW = new Date('2026-09-24T12:00:00.000Z');

function daysFromNow(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() + days * DAY_MS + extraMs);
}

/**
 * 架空の資格情報（実装プラン §2「テストの値」）。
 *
 * * `torifune` を含めない（CI の `DATABASE_URL` の password と同じ綴りを Core が伏せるため）
 * * トークンに `encodeURIComponent` / `URLSearchParams` で形の変わる文字（`|`）を含める
 * * 先頭 8 文字が固定文（「Threads の…」「HTTP」など）の部分文字列にならない
 */
const SAMPLE_THREADS_USER_ID = '17841400000000000';
const SAMPLE_ACCESS_TOKEN = 'THqZ7w|kP9~x-2.v_Lm';

/** `https://a.example/xy` はちょうど 20 文字（#30 の「link 20 文字」）。 */
const LINK = 'https://a.example/xy';

/** 👍 U+1F44D。§9.4 の数え方で 4。 */
const THUMBS_UP = '\u{1F44D}';

/** Web Intent の URL の前半（設計 §9.5）。#32 の長さの前提を独立に計算するためだけに使う。 */
const INTENT_PREFIX = 'https://www.threads.com/intent/post?text=';

/** #33 の文言の趣旨（設計 §9.2 の 1）。 */
const LONE_SURROGATE_WORDS = '扱えない文字';

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'threads',
    displayName: '見本のアカウント',
    handle: 'sample.handle',
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
    scheduledAt: '2026-09-24T12:00:00.000Z',
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

/** 呼ばれたら投げる `fetch`（#107）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
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

function publisher() {
  return createThreadsPublisher();
}

/** `validate()` を同期で呼ぶ（#37：Promise を返したらここで落ちる）。 */
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

/** `manual()` を同期で呼ぶ（#43：Promise を返したらここで落ちる）。 */
function manual(post: SocialPostView, account: SocialAccountView = accountView()) {
  const registration = publisher();
  if (registration.manual === undefined) {
    throw new Error('manual() が実装されていない');
  }
  const result = registration.manual({ post, account });
  if (result instanceof Promise) {
    throw new Error('manual() が同期で返していない');
  }
  return result;
}

function fieldsOf(problems: readonly PublisherValidationProblem[]): string[] {
  return problems.map((problem) => problem.field);
}

/** 異なる URL を `count` 本、空白で区切って並べた本文。 */
function urls(count: number, prefix = 'https://a.example/p'): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
}

/* -------------------------------------------------------------------------- */
/* 登録（#14〜#17）                                                              */
/* -------------------------------------------------------------------------- */

describe('登録（#14〜#17）', () => {
  it('#14 provider が threads で、label が Threads', () => {
    const registration = publisher();

    expect(registration.provider).toBe('threads');
    expect(registration.label).toBe('Threads');
  });

  it('#15 資格情報の項目は threadsUserId / accessToken / accessTokenExpiresAt の 3 つちょうど', () => {
    // **後から足せない**（設計 §5.1）。3 つ目まで最初の版で決め切る。
    expect(publisher().credentialFields.map((field) => field.key)).toEqual([
      'threadsUserId',
      'accessToken',
      'accessTokenExpiresAt',
    ]);
  });

  it('#15 kind は text / secret / text', () => {
    expect(publisher().credentialFields.map((field) => field.kind)).toEqual([
      'text',
      'secret',
      'text',
    ]);
  });

  it('#15 3 つとも description が空でない', () => {
    // /social の欄の下に出る（039 §7.1.2）。入力の時点で読まれる場所に注意を書く（設計 §5.1）。
    for (const field of publisher().credentialFields) {
      expect(typeof field.description, field.key).toBe('string');
      expect((field.description ?? '').trim().length, field.key).toBeGreaterThan(0);
    }
  });

  it('#15 accessTokenExpiresAt の description に unknown が現れる', () => {
    // 期限が分からない人の逃げ道。次の配信の成功で正しい期限に直る（設計 §5.2）。
    const field = publisher().credentialFields.find((item) => item.key === 'accessTokenExpiresAt');

    expect(field?.description ?? '').toContain('unknown');
  });

  it('#15 threadsUserId の description に「ユーザーネームではありません」が現れる', () => {
    // 書かないと、利用者は @ で始まる名前を入れる（実装プラン T1 の注意）。
    const field = publisher().credentialFields.find((item) => item.key === 'threadsUserId');

    expect(field?.description ?? '').toContain('ユーザーネームではありません');
  });

  it('#15 accessToken の description に threads_content_publish が現れる', () => {
    // 権限の足りないトークンを入れさせない（設計 §5.1）。
    const field = publisher().credentialFields.find((item) => item.key === 'accessToken');

    expect(field?.description ?? '').toContain('threads_content_publish');
  });

  it('#16 limits は { mediaMax: 10 } ちょうど', () => {
    expect(publisher().limits).toStrictEqual({ mediaMax: 10 });
  });

  it('#16 limits に bodyMaxLength と mediaRequired のキーが無い（undefined の値も置かない）', () => {
    // 本文の判定は validate() が §9.4 の数え方で行う。テキストだけの投稿ができる（設計 §9.1）。
    const limits = publisher().limits ?? {};

    expect('bodyMaxLength' in limits).toBe(false);
    expect('mediaRequired' in limits).toBe(false);
  });

  it('#16 limits のキーは PublisherLimits の部分集合', () => {
    for (const key of Object.keys(publisher().limits ?? {})) {
      expect(PUBLISHER_LIMIT_KEYS as readonly string[], key).toContain(key);
    }
  });

  it('#17 validate がある', () => {
    expect(typeof publisher().validate).toBe('function');
  });

  it('#17 manual がある', () => {
    expect(typeof publisher().manual).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */
/* validate()（#30〜#38）                                                       */
/* -------------------------------------------------------------------------- */

describe('validate()：本文の長さ（#30）', () => {
  it('#30 本文 500 文字なら問題なし', () => {
    expect(validate(draft({ body: 'a'.repeat(500) }))).toEqual([]);
  });

  it('#30 本文 501 文字なら body の問題が 1 件', () => {
    expect(fieldsOf(validate(draft({ body: 'a'.repeat(501) })))).toEqual(['body']);
  });

  it('#30 文言に上限の 500 と現在の値 501 が現れる', () => {
    const [problem] = validate(draft({ body: 'a'.repeat(501) }));

    expect(problem?.message ?? '').toContain('500');
    expect(problem?.message ?? '').toContain('501');
  });

  it('#30 §9.4 の数え方で数える：a×497 ＋ 👍 は 501 で body の問題（String.length は 499）', () => {
    // String.length で数える誤った実装では通ってしまう本文（実装プラン §8 の 16）。
    const body = `${'a'.repeat(497)}${THUMBS_UP}`;
    const problems = validate(draft({ body }));

    expect(body.length).toBe(499);
    expect(fieldsOf(problems)).toEqual(['body']);
    expect(problems[0]?.message ?? '').toContain('501');
  });

  it('#30 a×496 ＋ 👍 は 500 で問題なし', () => {
    expect(validate(draft({ body: `${'a'.repeat(496)}${THUMBS_UP}` }))).toEqual([]);
  });

  it('#30 link を含めて数える：本文 480 ＋ 改行 ＋ link 20 文字 → 501 で body の問題', () => {
    expect(LINK).toHaveLength(20);
    const problems = validate(draft({ body: 'a'.repeat(480), link: LINK }));

    expect(fieldsOf(problems)).toEqual(['body']);
    expect(problems[0]?.message ?? '').toContain('501');
  });

  it('#30 本文 479 ＋ 改行 ＋ link 20 文字 → 500 で問題なし', () => {
    expect(validate(draft({ body: 'a'.repeat(479), link: LINK }))).toEqual([]);
  });
});

describe('validate()：リンクの本数（#31）', () => {
  it('#31 異なる URL が 5 本なら問題なし', () => {
    expect(validate(draft({ body: urls(5) }))).toEqual([]);
  });

  it('#31 異なる URL が 6 本なら body の問題が 1 件', () => {
    expect(fieldsOf(validate(draft({ body: urls(6) })))).toEqual(['body']);
  });

  it('#31 文言に「5本」と現在の本数 6 が現れる', () => {
    const [problem] = validate(draft({ body: urls(6) }));

    expect(problem?.message ?? '').toContain('5本');
    expect(problem?.message ?? '').toMatch(/6\s*本/);
  });

  it('#31 本文の URL 5 本 ＋ 本文に無い link → 6 本で body の問題', () => {
    expect(fieldsOf(validate(draft({ body: urls(5), link: LINK })))).toEqual(['body']);
  });

  it('#31 link が本文の URL と同じなら 5 本のままで問題なし', () => {
    expect(validate(draft({ body: urls(5), link: 'https://a.example/p0' }))).toEqual([]);
  });

  it('#31 同じ URL を何度書いても 1 本と数える（6 回書いても問題なし）', () => {
    const body = Array.from({ length: 6 }, () => 'https://a.example/same').join(' ');

    expect(validate(draft({ body }))).toEqual([]);
  });
});

describe('validate()：手動投稿の intent URL の長さ（#32）', () => {
  /** intent URL が 2048 文字ちょうどになる本文（日本語 1 文字は 9 文字に符号化される。実装プラン §8 の 16）。 */
  const BODY_2048 = 'あ'.repeat(223);
  const BODY_2049 = `${'あ'.repeat(223)}a`;

  it('#32 前提：表の本文の intent URL はちょうど 2048 / 2049 文字', () => {
    // 長さは実装を使わずに計算する（ここが崩れると #32 が境界を見なくなる）。
    expect(INTENT_PREFIX.length + encodeURIComponent(BODY_2048).length).toBe(2048);
    expect(INTENT_PREFIX.length + encodeURIComponent(BODY_2049).length).toBe(2049);
  });

  it('#32 manual で intent URL が 2049 文字なら body の問題が 1 件（本文の長さは 500 以内）', () => {
    expect(fieldsOf(validate(draft({ deliveryMode: 'manual', body: BODY_2049 })))).toEqual([
      'body',
    ]);
  });

  it('#32 同じ本文を auto では問題にしない', () => {
    expect(validate(draft({ deliveryMode: 'auto', body: BODY_2049 }))).toEqual([]);
  });

  it('#32 manual で intent URL が 2048 文字ちょうどなら問題なし', () => {
    expect(validate(draft({ deliveryMode: 'manual', body: BODY_2048 }))).toEqual([]);
  });

  it('#32 intent URL の長さは link を繋いだ後の本文で数える（2048 の本文 ＋ link → 問題）', () => {
    expect(
      fieldsOf(validate(draft({ deliveryMode: 'manual', body: BODY_2048, link: LINK }))),
    ).toEqual(['body']);
  });
});

/** 対になっていないサロゲート（#29 の 4 通り）。 */
const LONE_SURROGATE_POSTS: readonly {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
  readonly replaced: string;
}[] = [
  { label: 'U+D800 だけ', body: '\ud800', link: null, replaced: '\uFFFD' },
  { label: 'a の後の U+DC00', body: 'a\udc00', link: null, replaced: 'a\uFFFD' },
  { label: '並びの途中の U+D800', body: 'ab\ud800cd', link: null, replaced: 'ab\uFFFDcd' },
  {
    label: 'link の中の U+D800',
    body: 'abc',
    link: 'https://a.example/\ud800',
    replaced: 'abc\nhttps://a.example/\uFFFD',
  },
];

describe('validate()：対になっていないサロゲート（#33）', () => {
  for (const deliveryMode of ['auto', 'manual'] as const) {
    it.each(LONE_SURROGATE_POSTS)(
      `#33 ${deliveryMode}：例外を投げず body の問題を 1 件だけ返す：$label`,
      (row) => {
        const post = draft({ deliveryMode, body: row.body, link: row.link });

        expect(() => validate(post)).not.toThrow();
        const problems = validate(post);
        expect(fieldsOf(problems)).toEqual(['body']);
        expect(problems[0]?.message ?? '').toContain(LONE_SURROGATE_WORDS);
      },
    );

    it(`#33 ${deliveryMode}：片割れがあれば長さの問題を重ねない（本文 600 文字 ＋ 片割れ → 1 件）`, () => {
      const problems = validate(draft({ deliveryMode, body: `${'a'.repeat(600)}\ud800` }));

      expect(fieldsOf(problems)).toEqual(['body']);
      expect(problems[0]?.message ?? '').toContain(LONE_SURROGATE_WORDS);
    });

    it(`#33 ${deliveryMode}：片割れがあれば URL の本数の問題を重ねない（URL 6 本 ＋ 片割れ → 1 件）`, () => {
      // 設計 §9.2 の 1：「あれば 2・3 を数えない」。
      const problems = validate(draft({ deliveryMode, body: `${urls(6)} \ud800` }));

      expect(fieldsOf(problems)).toEqual(['body']);
      expect(problems[0]?.message ?? '').toContain(LONE_SURROGATE_WORDS);
    });
  }

  it('#33 manual：片割れがあれば intent URL の長さの問題を重ねない（日本語 300 文字 ＋ 片割れ → 1 件）', () => {
    const problems = validate(draft({ deliveryMode: 'manual', body: `${'あ'.repeat(300)}\ud800` }));

    expect(fieldsOf(problems)).toEqual(['body']);
    expect(problems[0]?.message ?? '').toContain(LONE_SURROGATE_WORDS);
  });

  it('#33 正しいサロゲートの対（👍）は問題にしない（auto / manual）', () => {
    for (const deliveryMode of ['auto', 'manual'] as const) {
      expect(validate(draft({ deliveryMode, body: `いいね${THUMBS_UP}` })), deliveryMode).toEqual(
        [],
      );
    }
  });
});

describe('validate()：providerOptions（#34）', () => {
  it('#34 providerOptions.replyTo は providerOptions.replyTo の問題', () => {
    const problems = validate(draft({ providerOptions: { replyTo: '1' } }));

    expect(fieldsOf(problems)).toEqual(['providerOptions.replyTo']);
    expect(problems[0]?.message ?? '').toContain('replyTo');
  });

  it('#34 providerOptions が {} なら問題なし', () => {
    expect(validate(draft({ providerOptions: {} }))).toEqual([]);
  });

  it('#34 キーが複数ならキーごとに返す', () => {
    const problems = validate(draft({ providerOptions: { replyTo: '1', topicTag: 'x' } }));

    expect(fieldsOf(problems).sort()).toEqual([
      'providerOptions.replyTo',
      'providerOptions.topicTag',
    ]);
  });
});

describe('validate()：Core に任せるものを見ない（#35）', () => {
  function media(count: number, overrides: { url?: string; alt?: string | null } = {}) {
    return Array.from({ length: count }, (_, index) => ({
      url: overrides.url ?? `https://cdn.example.com/${index}.jpg`,
      alt: overrides.alt === undefined ? null : overrides.alt,
    }));
  }

  it('#35 media が 0 件でも枚数の問題を返さない', () => {
    expect(validate(draft({ media: [] }))).toEqual([]);
  });

  it('#35 media が 11 件でも枚数の問題を返さない', () => {
    expect(validate(draft({ media: media(11) }))).toEqual([]);
  });

  it('#35 media[].alt が 1000 文字でも問題を返さない', () => {
    expect(validate(draft({ media: media(1, { alt: 'あ'.repeat(1000) }) }))).toEqual([]);
  });

  it('#35 media[].url が http:// でも問題を返さない', () => {
    expect(validate(draft({ media: media(1, { url: 'http://cdn.example.com/a.jpg' }) }))).toEqual(
      [],
    );
  });
});

describe('validate()：例外を投げない（#36）', () => {
  it('#36 providerOptions が null でも配列を返す', () => {
    const post = draft({
      providerOptions: null as unknown as SocialPostDraftView['providerOptions'],
    });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#36 providerOptions が配列でも配列を返す', () => {
    const post = draft({
      providerOptions: ['replyTo'] as unknown as SocialPostDraftView['providerOptions'],
    });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#36 providerOptions が循環参照を含んでも配列を返し、キーの問題を返す', () => {
    // JSON.stringify で舐めると落ちる（実装プラン T6 の注意）。
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const problems = validate(
      draft({ providerOptions: circular as SocialPostDraftView['providerOptions'] }),
    );

    expect(fieldsOf(problems)).toEqual(['providerOptions.self']);
  });

  it('#36 media に null 要素があっても配列を返す', () => {
    const post = draft({ media: [null] as unknown as SocialPostDraftView['media'] });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#36 media が配列でなくても配列を返す', () => {
    const post = draft({ media: null as unknown as SocialPostDraftView['media'] });

    expect(Array.isArray(validate(post))).toBe(true);
  });

  it('#36 body が文字列でなくても配列を返す', () => {
    for (const body of [123, null, undefined, { a: 1 }, ['x']]) {
      const post = draft({ body: body as unknown as string });

      expect(Array.isArray(validate(post)), JSON.stringify(body)).toBe(true);
    }
  });

  it('#36 link が文字列でなくても配列を返す', () => {
    for (const link of [42, { href: LINK }, [LINK], true]) {
      const post = draft({ link: link as unknown as string });

      expect(Array.isArray(validate(post)), JSON.stringify(link)).toBe(true);
    }
  });
});

describe('validate()：同期で外へ出ない（#37）', () => {
  it('#37 同期で配列を返し（Promise でない）、fetch を 1 度も呼ばない', () => {
    const registration = publisher();
    const result = registration.validate?.({
      post: draft({ body: `${'a'.repeat(501)} ${urls(6)}`, link: LINK }),
      account: accountView(),
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
    validate(draft({ deliveryMode: 'manual', body: 'あ'.repeat(300) }));
    expect(fetchCalls).toBe(0);
  });
});

describe('validate()：複数の違反（#38）', () => {
  /** URL 6 本で、§9.4 の長さがちょうど 501 になる本文。 */
  function body501With6Urls(): string {
    const head = urls(6);
    return `${head} ${'a'.repeat(501 - head.length - 1)}`;
  }

  it('#38 前提：本文は 501 文字で、URL は 6 本', () => {
    const body = body501With6Urls();

    expect(body).toHaveLength(501);
    expect(body.match(/https:\/\//g)).toHaveLength(6);
  });

  it('#38 長さ 501 ＋ URL 6 本 ＋ providerOptions 1 キー → 3 件すべて返る', () => {
    // 順序は仮定しない（実装プラン T6 の注意）。
    const problems = validate(
      draft({ body: body501With6Urls(), providerOptions: { replyTo: '1' } }),
    );

    expect(fieldsOf(problems).sort()).toEqual(['body', 'body', 'providerOptions.replyTo']);
  });

  it.each(['auto', 'manual'] as const)(
    '#38 deliveryMode が %s でも本文の長さ・URL の本数・providerOptions を同じに見る',
    (deliveryMode) => {
      // 設計 §9.2 の最後：手動でも Threads の画面で送信できない本文は断る。
      expect(fieldsOf(validate(draft({ deliveryMode, body: 'a'.repeat(501) })))).toEqual(['body']);
      expect(fieldsOf(validate(draft({ deliveryMode, body: urls(6) })))).toEqual(['body']);
      expect(
        fieldsOf(validate(draft({ deliveryMode, providerOptions: { replyTo: '1' } }))),
      ).toEqual(['providerOptions.replyTo']);
    },
  );

  it('#30〜#33 validate() の body の問題は checkThreadsText の結果そのもの', () => {
    // 本文について言うことは必ず threads-text.ts の checkThreadsText から来る（設計 §9.2 の前書き）。
    for (const post of [
      draft({ body: 'a'.repeat(501) }),
      draft({ body: urls(6) }),
      draft({ body: 'a'.repeat(480), link: LINK }),
      draft({ deliveryMode: 'manual', body: `${'あ'.repeat(223)}a` }),
      draft({ deliveryMode: 'manual', body: 'ab\ud800cd' }),
      draft({ body: body501With6Urls() }),
      draft({ body: 'こんにちは' }),
    ]) {
      const bodyProblems = validate(post).filter((problem) => problem.field === 'body');

      expect(bodyProblems).toEqual(
        checkThreadsText({ body: post.body, link: post.link, deliveryMode: post.deliveryMode }),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* manual()（#40〜#43）                                                         */
/* -------------------------------------------------------------------------- */

/** `validate()`（manual）が `[]` を返す本文と link の組（#40）。 */
const MANUAL_CASES: readonly {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
}[] = [
  { label: '日本語', body: 'こんにちは', link: null },
  { label: '& # + % を含む', body: 'A&B #tag 1+1 100%', link: null },
  { label: '改行を含む', body: '一行目\n二行目', link: null },
  { label: '絵文字を含む', body: `いいね${THUMBS_UP}`, link: null },
  { label: 'link を持つ', body: '見てください', link: LINK },
  { label: 'クエリと断片を持つ link', body: '本文', link: 'https://a.example/a?x=1&y=2#frag' },
  { label: 'URL 5 本', body: urls(5), link: null },
  { label: '本文 500 文字（ASCII）', body: 'a'.repeat(500), link: null },
  { label: '日本語 223 文字（intent URL 2048 文字ちょうど）', body: 'あ'.repeat(223), link: null },
  { label: '空の本文', body: '', link: null },
];

describe('manual()（#40〜#43）', () => {
  it.each(MANUAL_CASES)(
    '#40 validate() が [] を返す manual の投稿の url は Core の isValidManualUrl に通る：$label',
    (row) => {
      // 前提：この行は validate() を通る（通らない行では #40 を見たことにならない）。
      expect(validate(draft({ deliveryMode: 'manual', body: row.body, link: row.link }))).toEqual(
        [],
      );

      const { url } = manual(postView({ body: row.body, link: row.link }));

      expect(isValidManualUrl(url)).toBe(true);
    },
  );

  it.each(LONE_SURROGATE_POSTS)(
    '#41 片割れを含む本文でも例外を投げず、text が片割れを U+FFFD に置き換えた文字列に戻る：$label',
    (row) => {
      // manual() は validate() を通っていない投稿でも呼ばれうる（設計 §9.5）。
      const post = postView({ body: row.body, link: row.link });

      expect(() => manual(post)).not.toThrow();
      expect(new URL(manual(post).url).searchParams.get('text')).toBe(row.replaced);
    },
  );

  it('#42 戻り値は { url: buildThreadsIntentUrl(post), note: THREADS_MANUAL_NOTE } ちょうど', () => {
    const post = postView({ body: '本文です', link: LINK });

    expect(manual(post)).toStrictEqual({
      url: buildThreadsIntentUrl(post),
      note: THREADS_MANUAL_NOTE,
    });
  });

  it('#42 url の text に本文と link が改行で入る', () => {
    const { url } = manual(postView({ body: '本文です', link: LINK }));

    expect(new URL(url).searchParams.get('text')).toBe(`本文です\n${LINK}`);
  });

  it.each(['画像', '投稿画面', '添える場合は'])('#42 note に「%s」が含まれる', (word) => {
    expect(manual(postView()).note ?? '').toContain(word);
  });

  it('#42 note は添付を断定しない（「画像は…添付してください」と書かない）', () => {
    // 手動投稿に media は付けられない（Core が 422）。断定すると付けた画像が落ちたと読まれる（設計 §9.5）。
    expect(THREADS_MANUAL_NOTE).not.toMatch(/画像は[^。]*添付してください/);
  });

  it('#43 同期で返る（Promise でない）', () => {
    const result = publisher().manual?.({ post: postView(), account: accountView() });

    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('#43 fetch を呼ばない', () => {
    manual(postView({ body: '本文です', link: LINK }));
    manual(postView({ body: 'ab\ud800cd' }));

    expect(fetchCalls).toBe(0);
  });

  it('#43 account の値を変えても戻り値が変わらない', () => {
    // Web Intent はブラウザでログイン中のアカウントで開く。どのアカウントかを指定できない（設計 §9.5）。
    const post = postView({ body: '本文です', link: LINK });
    const other = accountView({
      id: '0199aaaa-0000-7000-8000-00000000a999',
      displayName: '別のアカウント',
      handle: 'another.handle',
      status: 'disabled',
      credentialConfigured: false,
    });

    expect(manual(post, other)).toStrictEqual(manual(post, accountView()));
  });
});

/* -------------------------------------------------------------------------- */
/* token.ts：資格情報の形と期限の判定（設計 §5.2 / §6.2 / §6.7）                     */
/* -------------------------------------------------------------------------- */

describe('token.ts：threadsUserId の形（isValidThreadsUserId）', () => {
  it.each([SAMPLE_THREADS_USER_ID, '1', '9'.repeat(64)])('数字だけの %j は通る', (value) => {
    expect(isValidThreadsUserId(value)).toBe(true);
  });

  it.each([
    ['英字', 'abc'],
    ['パスの移動', '1/../2'],
    ['クエリ', '1?x=1'],
    ['65 桁', '9'.repeat(65)],
    ['空文字', ''],
    ['前の空白', ' 123'],
    ['後ろの空白', '123 '],
    ['全角の数字', '１２３'],
    ['@ で始まるユーザーネーム', '@threads_user'],
    ['負号', '-1'],
    ['小数点', '1.5'],
  ])('#65 P0 の前提：%s（%j）は通らない', (_label, value) => {
    expect(isValidThreadsUserId(value)).toBe(false);
  });

  it('文字列でなければ通らない（数値の ID も含む）', () => {
    expect(isValidThreadsUserId(17841400000000000 as unknown as string)).toBe(false);
    expect(isValidThreadsUserId(undefined as unknown as string)).toBe(false);
    expect(isValidThreadsUserId(null as unknown as string)).toBe(false);
  });
});

describe('token.ts：accessToken の形（isValidAccessToken）', () => {
  /** U+0021〜U+007E の印字可能な ASCII をすべて並べたもの。 */
  const PRINTABLE_ASCII = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
    String.fromCharCode(0x21 + index),
  ).join('');

  it('見本のトークン（| と ~ を含む）は通る', () => {
    expect(isValidAccessToken(SAMPLE_ACCESS_TOKEN)).toBe(true);
  });

  it('印字可能な ASCII（U+0021〜U+007E）だけなら通る', () => {
    expect(isValidAccessToken(PRINTABLE_ASCII)).toBe(true);
  });

  it('2048 文字は通り、2049 文字は通らない', () => {
    expect(isValidAccessToken('a'.repeat(2048))).toBe(true);
    expect(isValidAccessToken('a'.repeat(2049))).toBe(false);
  });

  it.each([
    ['改行', 'THqZ7w\nkP9'],
    ['CR', 'THqZ7w\rkP9'],
    ['空白', 'THqZ7w kP9'],
    ['タブ', 'THqZ7w\tkP9'],
    ['全角文字', 'THqZ7wａkP9'],
    ['日本語', 'トークン'],
    ['空文字', ''],
    ['DEL', `THqZ7w${String.fromCharCode(0x7f)}kP9`],
    ['NUL', `THqZ7w${String.fromCharCode(0)}kP9`],
  ])('#61 / #65 P0 の前提：%s を含むトークンは通らない', (_label, value) => {
    expect(isValidAccessToken(value)).toBe(false);
  });

  it('文字列でなければ通らない', () => {
    expect(isValidAccessToken(null as unknown as string)).toBe(false);
    expect(isValidAccessToken(12345 as unknown as string)).toBe(false);
  });
});

describe('token.ts：期限の読み取り（parseExpiry）', () => {
  /** 読めた期限を ISO 文字列にする（戻り値の表し方は Date でも数値でもよい）。 */
  function isoOf(expiry: ReturnType<typeof parseExpiry>): string {
    return new Date(expiry as unknown as Date | number).toISOString();
  }

  it('ISO 8601 の期限を読める', () => {
    const expiry = parseExpiry('2026-10-24T12:00:00Z', NOW);

    expect(expiry).not.toBe('unknown');
    expect(isoOf(expiry)).toBe('2026-10-24T12:00:00.000Z');
  });

  it('前後の空白を許す', () => {
    expect(isoOf(parseExpiry('  2026-10-24T12:00:00Z  ', NOW))).toBe('2026-10-24T12:00:00.000Z');
  });

  it.each(['unknown', 'UNKNOWN', '', '   ', 'あした'])('#59 %j は unknown', (value) => {
    expect(parseExpiry(value, NOW)).toBe('unknown');
  });

  it('#59 61 日より先（2099-01-01T00:00:00Z）は unknown（打ち間違いを信じない）', () => {
    expect(parseExpiry('2099-01-01T00:00:00Z', NOW)).toBe('unknown');
  });

  it('ちょうど 61 日後は期限として読む', () => {
    const value = daysFromNow(61).toISOString();

    expect(isoOf(parseExpiry(value, NOW))).toBe(value);
  });

  it('61 日後を 1 ミリ秒でも過ぎたら unknown', () => {
    expect(parseExpiry(daysFromNow(61, 1).toISOString(), NOW)).toBe('unknown');
  });

  it('過ぎた期限は読める（延長の判定に回す）', () => {
    const value = daysFromNow(-1).toISOString();

    expect(isoOf(parseExpiry(value, NOW))).toBe(value);
  });

  it('文字列でなければ unknown', () => {
    expect(parseExpiry(undefined as unknown as string, NOW)).toBe('unknown');
    expect(parseExpiry(1_790_000_000_000 as unknown as string, NOW)).toBe('unknown');
  });
});

describe('token.ts：延長の要否（shouldRefresh）', () => {
  function refreshFor(value: string): boolean {
    return shouldRefresh(parseExpiry(value, NOW), NOW);
  }

  it('#57 残り 29 日なら延長する', () => {
    expect(refreshFor(daysFromNow(29).toISOString())).toBe(true);
  });

  it('#58 残り 31 日なら延長しない', () => {
    expect(refreshFor(daysFromNow(31).toISOString())).toBe(false);
  });

  it('残りちょうど 30 日なら延長しない（30 日を「切って」いない）', () => {
    expect(refreshFor(daysFromNow(30).toISOString())).toBe(false);
  });

  it('残り 30 日を 1 ミリ秒切ったら延長する', () => {
    expect(refreshFor(daysFromNow(30, -1).toISOString())).toBe(true);
  });

  it.each(['unknown', '', 'あした', '2099-01-01T00:00:00Z'])('#59 %j なら延長する', (value) => {
    expect(refreshFor(value)).toBe(true);
  });

  it('#59 unknown をそのまま渡しても延長する', () => {
    expect(shouldRefresh('unknown', NOW)).toBe(true);
  });

  it('過ぎた期限なら延長を試みる', () => {
    expect(refreshFor(daysFromNow(-1).toISOString())).toBe(true);
  });

  it('閾値は 30 日、最長の寿命は 61 日', () => {
    expect(TOKEN_REFRESH_THRESHOLD_MS).toBe(30 * DAY_MS);
    expect(TOKEN_MAX_LIFETIME_MS).toBe(61 * DAY_MS);
  });
});

describe('token.ts：expires_in から期限を作る（expiryFromExpiresIn）', () => {
  it('#57 60 日（5184000 秒）なら now ＋ 60 日の ISO 文字列', () => {
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
  ] as const)('#62 expires_in が %s なら unknown', (_label, value) => {
    expect(expiryFromExpiresIn(value, NOW)).toBe('unknown');
  });

  it('作った期限は parseExpiry で読み戻せる', () => {
    const value = expiryFromExpiresIn(5_184_000, NOW);

    expect(parseExpiry(value, NOW)).not.toBe('unknown');
  });
});
