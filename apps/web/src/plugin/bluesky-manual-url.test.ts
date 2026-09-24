import type {
  PluginStore,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidManualUrl } from '@/domain/social/social';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';

/**
 * Bluesky 配信 Plugin：手動投稿の Web Intent の URL の長さと、対になっていないサロゲート
 * （042-social-api-input-fixes 設計 §9.2、受け入れ条件 #1〜#11）。
 *
 * 手動投稿（`deliveryMode: 'manual'`）のときだけ、`validate()` が次の 2 つを `body` の問題として返す。
 *
 * - #7：`body`（link があれば `body + '\n' + link`）に対になっていないサロゲートがある
 * - #8：`https://bsky.app/intent/compose?text=` + エンコードした文字列が 2048 文字を超える（#7 に当たったら数えない）
 *
 * `manual()` は片割れのサロゲートを U+FFFD に置き換えてからエンコードし、例外を投げない。
 *
 * **受け入れ条件は `validate()` / `manual()` の外から見た振る舞いで確かめる。** URL を組み立てる関数は import しない。
 * `'あ'` は UTF-8 で 3 バイト（URL の中で 9 文字）。`MANUAL_INTENT_URL + '?text='` は 37 文字。
 *
 * 注：
 * - ファイル名を `sns-bluesky` で始めない（既存の静的検査が `sns-bluesky` で始まる単体テストの本数を固定している。
 *   042 実装プラン §4「静的検査の本数」）。値の作り方は `sns-bluesky.test.ts` から写し、共有しない
 * - `beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換え、`afterEach` で戻す
 */

/** 設計 §9.2 の #8 の文言。 */
const URL_TOO_LONG_MESSAGE = '投稿画面の URL が長くなりすぎます。本文を短くしてください。';

/** 設計 §9.2 の #7 の文言。 */
const LONE_SURROGATE_MESSAGE = '本文に扱えない文字が含まれています。';

const INTENT_PREFIX = 'https://bsky.app/intent/compose?text=';

/** Core の `isValidManualUrl` の上限（設計 §4）。 */
const MANUAL_URL_MAX_LENGTH = 2048;

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 値                                                                           */
/* -------------------------------------------------------------------------- */

/** 最小の Key-Value Store。`validate()` / `manual()` は読まない。 */
function unusedStore(): PluginStore {
  const unused = (): never => {
    throw new Error('使わない');
  };
  return {
    get: unused,
    set: unused,
    delete: unused,
    keys: unused,
    setSecret: unused,
    getSecret: unused,
    hasSecret: unused,
  };
}

function accountView(): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a042',
    provider: 'bluesky',
    displayName: 'とりふね',
    handle: 'torifune.example',
    status: 'active',
    credentialConfigured: true,
  };
}

function draft(overrides: Partial<SocialPostDraftView> = {}): SocialPostDraftView {
  return {
    body: 'こんにちは',
    scheduledAt: null,
    deliveryMode: 'manual',
    media: [],
    link: null,
    providerOptions: {},
    ...overrides,
  };
}

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000b042',
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

function publisher() {
  return createBlueskyPublisher({ store: unusedStore() });
}

/** `validate()` を同期で呼ぶ。 */
function validate(post: SocialPostDraftView): readonly PublisherValidationProblem[] {
  const registration = publisher();
  if (registration.validate === undefined) {
    throw new Error('validate() が実装されていない');
  }
  const result = registration.validate({ post, account: accountView() });
  if (!Array.isArray(result)) {
    throw new Error('validate() が同期で配列を返していない');
  }
  return result;
}

/** `manual()` を同期で呼ぶ。 */
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

function fieldsOf(problems: readonly PublisherValidationProblem[]): string[] {
  return problems.map((problem) => problem.field);
}

function hasUrlProblem(problems: readonly PublisherValidationProblem[]): boolean {
  return problems.some(
    (problem) => problem.field === 'body' && problem.message === URL_TOO_LONG_MESSAGE,
  );
}

/* -------------------------------------------------------------------------- */
/* #1〜#3 手動投稿の URL の長さ                                                   */
/* -------------------------------------------------------------------------- */

describe('#1 URL がちょうど 2048 文字なら通る', () => {
  const body = 'あ'.repeat(223) + 'a'.repeat(4);

  it('#1 validate が []', () => {
    expect(validate(draft({ body, link: null }))).toEqual([]);
  });

  it('#1 manual の url が 2048 文字', () => {
    expect(manual(postView({ body, link: null })).url.length).toBe(2048);
  });
});

describe('#2 URL が 2049 文字なら body の問題がちょうど 1 件', () => {
  const body = 'あ'.repeat(223) + 'a'.repeat(5);

  it('#2 validate がちょうど 1 件で、field が body、message が URL の文言', () => {
    const problems = validate(draft({ body, link: null }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('body');
    expect(problems[0]?.message).toBe(URL_TOO_LONG_MESSAGE);
  });

  it('#2 manual の url が 2049 文字', () => {
    expect(manual(postView({ body, link: null })).url.length).toBe(2049);
  });
});

describe('#3 link を繋いだ後の文字列で URL を数える', () => {
  const body = 'あ'.repeat(220);
  const link = 'https://example.com/aaaa';

  it('#3 link ありなら URL の問題が 1 件（URL は 2052 文字）', () => {
    const problems = validate(draft({ body, link }));

    expect(manual(postView({ body, link })).url.length).toBe(2052);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('body');
    expect(problems[0]?.message).toBe(URL_TOO_LONG_MESSAGE);
  });

  it('#3 同じ本文で link なしなら []', () => {
    expect(validate(draft({ body, link: null }))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #4 自動配信では URL の長さを見ない                                             */
/* -------------------------------------------------------------------------- */

describe('#4 自動配信では URL の長さを見ない', () => {
  it('#4 auto、あ×290 → []', () => {
    expect(validate(draft({ deliveryMode: 'auto', body: 'あ'.repeat(290), link: null }))).toEqual(
      [],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #5・#6 対になっていないサロゲート                                              */
/* -------------------------------------------------------------------------- */

describe('#5 手動投稿の片割れのサロゲートは body の問題がちょうど 1 件', () => {
  it('#5 上位だけ（あ×250 + \\uD800）→ 扱えない文字の文言が 1 件で、URL の問題を重ねない', () => {
    const problems = validate(draft({ body: 'あ'.repeat(250) + '\uD800', link: null }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('body');
    expect(problems[0]?.message).toBe(LONE_SURROGATE_MESSAGE);
  });

  it('#5 前に上位が無い下位（a\\uDC00b）→ 扱えない文字の文言が 1 件', () => {
    const problems = validate(draft({ body: 'a\uDC00b', link: null }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('body');
    expect(problems[0]?.message).toBe(LONE_SURROGATE_MESSAGE);
  });
});

describe('#6 自動配信の片割れのサロゲートは 042 の前と同じ', () => {
  it('#6 auto、あ\\uD800 → []', () => {
    expect(validate(draft({ deliveryMode: 'auto', body: 'あ\uD800', link: null }))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #7 grapheme 数の問題と URL の問題を重ねて返す                                   */
/* -------------------------------------------------------------------------- */

describe('#7 grapheme 数の問題と URL の問題を重ねて返す', () => {
  const post = draft({ body: 'あ'.repeat(299), link: 'https://example.com/aaaa' });

  it('#7 field が [body, body]', () => {
    expect(fieldsOf(validate(post))).toEqual(['body', 'body']);
  });

  it('#7 一方が grapheme 数の問題（300文字）、他方が URL の問題', () => {
    const messages = validate(post).map((problem) => problem.message);

    expect(messages.some((message) => message.includes('300文字'))).toBe(true);
    expect(messages).toContain(URL_TOO_LONG_MESSAGE);
  });
});

/* -------------------------------------------------------------------------- */
/* #8 manual() は片割れで例外を投げない                                           */
/* -------------------------------------------------------------------------- */

describe('#8 片割れのサロゲートを含む投稿でも manual() は例外を投げない', () => {
  const post = postView({ body: 'あ\uD800', link: null });

  it('#8 例外を投げない', () => {
    expect(() => manual(post)).not.toThrow();
  });

  it('#8 url は片割れを U+FFFD に置き換えてエンコードしたもの', () => {
    expect(manual(post).url).toBe(INTENT_PREFIX + encodeURIComponent('あ�'));
  });

  it('#8 url は Core の isValidManualUrl に通る', () => {
    expect(isValidManualUrl(manual(post).url)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #10 validate の数えと manual の URL の一致                                     */
/* -------------------------------------------------------------------------- */

describe('#10 validate の URL の問題と manual の url の長さが一致する', () => {
  const cases = [222, 223, 224].flatMap((n) =>
    [null, 'https://example.com/'].map((link) => ({ n, link })),
  );

  it.each(cases)('#10 あ×$n、link=$link', ({ n, link }) => {
    const body = 'あ'.repeat(n);
    const urlLength = manual(postView({ body, link })).url.length;

    expect(hasUrlProblem(validate(draft({ body, link }))), `url.length=${urlLength}`).toBe(
      urlLength > MANUAL_URL_MAX_LENGTH,
    );
  });

  it('#10 境界の両側が現れている（全件が同じ側に寄っていない）', () => {
    // 222・223 は link なしで 2048 以内、224 は超える（設計 §9.2 の目安）。
    // 判別力の確認：どちらか一方だけの入力では「一致」を見ても意味が無い。
    const verdicts = cases.map(({ n, link }) =>
      hasUrlProblem(validate(draft({ body: 'あ'.repeat(n), link }))),
    );

    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #11 型の崩れた投稿でも例外を投げない                                           */
/* -------------------------------------------------------------------------- */

describe('#11 body・link が文字列でなくても validate / manual は例外を投げない', () => {
  const broken: readonly {
    readonly label: string;
    readonly body: unknown;
    readonly link: unknown;
  }[] = [
    { label: 'body が数値', body: 123, link: null },
    { label: 'body が null', body: null, link: null },
    { label: 'body が undefined', body: undefined, link: null },
    { label: 'link が数値', body: 'こんにちは', link: 42 },
    { label: 'link がオブジェクト', body: 'こんにちは', link: { href: 'https://example.com/' } },
  ];

  it.each(broken)('#11 validate：$label', ({ body, link }) => {
    const post = draft({ body, link } as unknown as Partial<SocialPostDraftView>);

    expect(() => validate(post)).not.toThrow();
  });

  it.each(broken)('#11 manual：$label', ({ body, link }) => {
    const post = postView({ body, link } as unknown as Partial<SocialPostView>);

    expect(() => manual(post)).not.toThrow();
  });
});
