import type {
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createXManualPublisher } from '../../../../plugins/sns-x-manual/social';
import {
  X_MANUAL_NOTE,
  buildXIntentUrl,
  checkXText,
} from '../../../../plugins/sns-x-manual/x-text';

/**
 * X 配信 Plugin（無料版・`sns-x-manual`）の単体検査（037-sns-x 設計 §9 / §10.4）。
 *
 * **外へ 1 本も要求を出さない Plugin**（設計 §6）。見るのは登録の形（#22）・`validate()`（#23 / #24）・
 * `manual()`（#25）だけで、どれも外部 I/O を持たない。
 *
 * #89 / #90：`globalThis.fetch` を「呼ばれたら投げる」実装にしたまま、すべてのテストが通る。
 */

const LINK = 'https://example.com/a';

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'x',
    displayName: 'とりふね',
    handle: 'torifune_example',
    status: 'active',
    credentialConfigured: false,
    ...overrides,
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

function publisher() {
  return createXManualPublisher();
}

/** `validate()` を同期で呼ぶ（#24：Promise を返したらここで落ちる）。 */
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

/** `manual()` を同期で呼ぶ（#25：Promise を返したらここで落ちる）。 */
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

describe('登録（#22）', () => {
  it('#22 provider が x で、label が X', () => {
    const registration = publisher();

    expect(registration.provider).toBe('x');
    expect(registration.label).toBe('X');
  });

  it('#22 credentialFields が空配列（資格情報を受け取らない）', () => {
    expect(publisher().credentialFields).toEqual([]);
  });

  it('#22 登録に publish のキーが無い', () => {
    // `publish: undefined` も書かない。publish を持たない publisher の最初の利用者（設計 §9）。
    expect('publish' in publisher()).toBe(false);
  });

  it('#22 登録に limits のキーが無い', () => {
    // auto は validate() が断り、manual は媒体を持てない（設計 §9.1）。
    expect('limits' in publisher()).toBe(false);
  });

  it('#22 validate と manual がある', () => {
    const registration = publisher();

    expect(typeof registration.validate).toBe('function');
    expect(typeof registration.manual).toBe('function');
  });
});

describe('validate()（#23）', () => {
  it('#23 deliveryMode: auto なら deliveryMode の問題が 1 件', () => {
    expect(fieldsOf(validate(draft({ deliveryMode: 'auto' })))).toEqual(['deliveryMode']);
  });

  it('#23 auto を断る文言に manual と sns-x-api が現れる', () => {
    // 無料版で auto を選んだ人に、何を指定し直せばよいか・自動には何が要るかを伝える（設計 §9.3）。
    const [problem] = validate(draft({ deliveryMode: 'auto' }));

    expect(problem?.message ?? '').toContain('manual');
    expect(problem?.message ?? '').toContain('sns-x-api');
  });

  it('#23 deliveryMode: manual で本文が正しければ問題なし', () => {
    expect(validate(draft({ deliveryMode: 'manual' }))).toEqual([]);
  });

  it('#23 manual で link があっても本文が正しければ問題なし', () => {
    expect(validate(draft({ deliveryMode: 'manual', link: LINK }))).toEqual([]);
  });

  it('#23 auto かつ本文の重み 281 なら deliveryMode と body の 2 件', () => {
    // 順序は仮定しない（実装プラン §8 の 10）。
    const problems = validate(draft({ deliveryMode: 'auto', body: 'a'.repeat(281) }));

    expect(problems).toHaveLength(2);
    expect(fieldsOf(problems).sort()).toEqual(['body', 'deliveryMode']);
  });

  it('#23 manual で本文の重み 281 なら body の問題だけ', () => {
    expect(fieldsOf(validate(draft({ body: 'a'.repeat(281) })))).toEqual(['body']);
  });

  it('#23 body の問題は x-text.ts の checkXText の結果そのもの', () => {
    // 本文について言うことは必ず checkXText から来る（設計 §4.2 / §9.2）。
    for (const post of [
      draft({ body: 'a'.repeat(281) }),
      draft({ body: 'a'.repeat(257), link: LINK }),
      draft({ body: `https://example.com/${'a'.repeat(2000)}` }),
      draft({ body: 'こんにちは' }),
    ]) {
      const bodyProblems = validate(post).filter((problem) => problem.field === 'body');

      expect(bodyProblems).toEqual(checkXText(post));
    }
  });
});

describe('validate()（#24）', () => {
  it('#24 providerOptions.replyTo を断る', () => {
    // 返信は Core に親子の概念が無いので受けない（設計 §3.2 / §9.2）。
    const problems = validate(draft({ providerOptions: { replyTo: '1' } }));

    expect(fieldsOf(problems)).toEqual(['providerOptions.replyTo']);
    expect(problems[0]?.message ?? '').toContain('replyTo');
  });

  it('#24 providerOptions のキーが複数ならキーごとに返す', () => {
    const problems = validate(draft({ providerOptions: { replyTo: '1', quote: '2' } }));

    expect(fieldsOf(problems).sort()).toEqual(['providerOptions.quote', 'providerOptions.replyTo']);
  });

  it('#24 providerOptions が null でも例外を投げない', () => {
    const post = draft({
      providerOptions: null as unknown as Readonly<Record<string, unknown>>,
    });

    expect(() => validate(post)).not.toThrow();
  });

  it('#24 providerOptions が配列でも例外を投げない', () => {
    const post = draft({
      providerOptions: ['replyTo'] as unknown as Readonly<Record<string, unknown>>,
    });

    expect(() => validate(post)).not.toThrow();
  });

  it('#24 providerOptions が循環参照を含んでも例外を投げない', () => {
    // JSON.stringify で舐めると落ちる（実装プラン T7 の注意）。
    const circular: Record<string, unknown> = { replyTo: '1' };
    circular['self'] = circular;

    expect(() => validate(draft({ providerOptions: circular }))).not.toThrow();
    expect(fieldsOf(validate(draft({ providerOptions: circular }))).sort()).toEqual([
      'providerOptions.replyTo',
      'providerOptions.self',
    ]);
  });

  it('#24 body や link が文字列でなくても例外を投げない', () => {
    // 外から来た任意の JSON。型を確かめてから触る（設計 §9.2）。
    const post = draft({
      body: 123 as unknown as string,
      link: { href: LINK } as unknown as string,
    });

    expect(() => validate(post)).not.toThrow();
  });

  it('#24 同期で返る', () => {
    const result = publisher().validate?.({ post: draft(), account: accountView() });

    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('manual()（#25）', () => {
  it('#25 { url: buildXIntentUrl(post), note: X_MANUAL_NOTE } を返す', () => {
    const post = postView({ body: '本文です', link: LINK });

    expect(manual(post)).toEqual({ url: buildXIntentUrl(post), note: X_MANUAL_NOTE });
  });

  it('#25 intent URL の text に本文と link が改行で入る', () => {
    const result = manual(postView({ body: '本文です', link: LINK }));

    expect(new URL(result.url).searchParams.get('text')).toBe(`本文です\n${LINK}`);
  });

  it('#25 同期で返る（Promise でない）', () => {
    const result = publisher().manual?.({ post: postView(), account: accountView() });

    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('#25 fetch を呼ばない', () => {
    manual(postView({ body: '本文です', link: LINK }));

    expect(fetchCalls).toBe(0);
  });

  it('#25 account の値を変えても戻り値が変わらない', () => {
    // Web Intent はブラウザでログイン中のアカウントで開く。どのアカウントかを指定できない（設計 §9.5）。
    const post = postView({ body: '本文です', link: LINK });
    const other = accountView({
      id: '0199aaaa-0000-7000-8000-00000000a999',
      displayName: '別のアカウント',
      handle: 'another_handle',
      status: 'disabled',
      credentialConfigured: true,
    });

    expect(manual(post, other)).toEqual(manual(post, accountView()));
  });
});

/* -------------------------------------------------------------------------- */
/* 対になっていないサロゲート（#93）                                              */
/* -------------------------------------------------------------------------- */

/** 対になっていないサロゲートを含む本文（設計 §9.4 / §10.16）。`replaced` は intent URL の text が戻る先。 */
const LONE_SURROGATES: readonly {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
  readonly replaced: string;
}[] = [
  { label: '先頭の U+D800', body: '\ud800abc', link: null, replaced: '\ufffdabc' },
  { label: '末尾の U+DC00', body: 'abc\udc00', link: null, replaced: 'abc\ufffd' },
  { label: '並びの途中の U+D800', body: 'ab\ud800cd', link: null, replaced: 'ab\ufffdcd' },
  {
    label: 'link の直前の U+D800',
    body: 'abc\ud800',
    link: LINK,
    replaced: `abc\ufffd\n${LINK}`,
  },
  {
    // link を繋いだ後の文字列を見るので、field は link ではなく body（設計 §10.16 #93）。
    label: 'link の中の U+D800',
    body: 'abc',
    link: 'https://example.com/\ud800',
    replaced: 'abc\nhttps://example.com/\ufffd',
  },
];

describe('対になっていないサロゲート（#93）', () => {
  it.each(LONE_SURROGATES)(
    '#93 validate()（manual）は例外を投げず body の問題を返す：$label',
    (row) => {
      const post = draft({ deliveryMode: 'manual', body: row.body, link: row.link });

      expect(() => validate(post)).not.toThrow();
      expect(fieldsOf(validate(post))).toEqual(['body']);
    },
  );

  it.each(LONE_SURROGATES)(
    '#93 validate()（auto）も例外を投げず、deliveryMode と body の問題を返す：$label',
    (row) => {
      const post = draft({ deliveryMode: 'auto', body: row.body, link: row.link });

      expect(() => validate(post)).not.toThrow();
      expect(fieldsOf(validate(post)).sort()).toEqual(['body', 'deliveryMode']);
    },
  );

  it('#93 正しいサロゲートの対（👍）は body の問題にしない', () => {
    expect(validate(draft({ deliveryMode: 'manual', body: 'いいね\ud83d\udc4d' }))).toEqual([]);
  });

  it.each(LONE_SURROGATES)(
    '#93 manual() も例外を投げず、intent URL の text は片割れを U+FFFD に置き換えた文字列：$label',
    (row) => {
      // manual() は validate() を通っていない投稿でも呼ばれうる（設計 §9.4）。
      const post = postView({ body: row.body, link: row.link });

      expect(() => manual(post)).not.toThrow();
      expect(new URL(manual(post).url).searchParams.get('text')).toBe(row.replaced);
    },
  );
});

describe('外へ出ない（#90）', () => {
  it('#90 投げる fetch のまま validate() と manual() がすべて通り、fetch が 1 度も呼ばれない', () => {
    const throwing = globalThis.fetch;

    expect(() => {
      validate(draft());
      validate(draft({ deliveryMode: 'auto' }));
      validate(draft({ body: 'a'.repeat(281), link: LINK }));
      validate(draft({ providerOptions: { replyTo: '1' } }));
      manual(postView());
      manual(postView({ body: '本文です', link: LINK }));
    }).not.toThrow();
    expect(globalThis.fetch).toBe(throwing);
    expect(fetchCalls).toBe(0);
  });
});
