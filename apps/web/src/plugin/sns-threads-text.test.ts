import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTERNAL_URL_MAX_LENGTH } from '@/domain/social/social';
import {
  MANUAL_URL_MAX_LENGTH,
  THREADS_INTENT_BASE_URL,
  THREADS_LINK_MAX,
  THREADS_MANUAL_NOTE,
  THREADS_TEXT_MAX,
  buildThreadsIntentUrl,
  buildThreadsManualHandoff,
  composeThreadsText,
  countThreadsLength,
  countThreadsLinks,
  hasLoneSurrogate,
} from '../../../../plugins/sns-threads/threads-text';

/**
 * Threads 配信 Plugin の `threads-text.ts` の単体検査（040-sns-threads 設計 §9.3 / §9.4 / §9.5 / §10.4 / §10.6）。
 *
 * 純関数だけを見る。**期待値は数値・文字列のリテラルで書き、`TextEncoder` や `Intl.Segmenter` で計算しない**
 * （実装と同じ計算を期待値にすると検査にならない。実装プラン T3 の注意）。
 *
 * 担当する受け入れ条件：#22〜#29、#39、#41（`buildThreadsIntentUrl` の側）、#82（URL の長さの側）。
 *
 * #107：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

/** Web Intent の URL の前半（設計 §9.5）。長さの計算と比較にだけ使う。 */
const INTENT_PREFIX = 'https://www.threads.com/intent/post?text=';

const LINK = 'https://a.example/link';

/* 絵文字の見本。**エスケープで書く**（どのコードポイントかを字面で読めるように）。 */

/** 👍 U+1F44D。UTF-8 で 4 バイト。 */
const THUMBS_UP = '\u{1F44D}';
/** 👍🏽 U+1F44D U+1F3FD（肌の色）。4 ＋ 4 = 8 バイト。 */
const THUMBS_UP_MEDIUM_SKIN = '\u{1F44D}\u{1F3FD}';
/** 👨‍👩‍👧‍👦 ZWJ で繋いだ 4 人家族。4 × 4 ＋ ZWJ（3 バイト）× 3 = 25 バイト。 */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
/** 🇯🇵 地域指示子 2 つ。4 ＋ 4 = 8 バイト。 */
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
/** ❤️ U+2764 U+FE0F。3 ＋ 3 = 6 バイト。 */
const RED_HEART = '\u2764\uFE0F';
/** 1️⃣ キーキャップ（'1' U+FE0F U+20E3）。1 ＋ 3 ＋ 3 = 7 バイト。 */
const KEYCAP_ONE = '1\uFE0F\u20E3';
/** © U+00A9（Extended_Pictographic に含まれる）。2 バイト。 */
const COPYRIGHT = '\u00A9';
/** タグ列の旗（スコットランド）（U+1F3F4 ＋ タグ 5 つ ＋ U+E007F）。4 ＋ 4 × 5 ＋ 4 = 28 バイト。 */
const FLAG_SCOTLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
/** 𠮷 U+20BB7（サロゲートペアの CJK。絵文字ではない）。UTF-16 で 2。 */
const CJK_SUPPLEMENTARY = '\u{20BB7}';
/** 分解された é（e ＋ U+0301）。正規化しないので UTF-16 で 2。 */
const DECOMPOSED_E_ACUTE = 'e\u0301';

interface LengthCase {
  readonly label: string;
  readonly text: string;
  readonly expected: number;
}

/**
 * #22〜#24 の表。#25（`String.length` を下回らない）もこの表の全行に掛ける。
 */
const LENGTH_CASES: readonly LengthCase[] = [
  { label: '#22 空文字', text: '', expected: 0 },
  { label: '#22 a×500', text: 'a'.repeat(500), expected: 500 },
  { label: '#22 あ×500', text: 'あ'.repeat(500), expected: 500 },
  { label: '#22 あ×501', text: 'あ'.repeat(501), expected: 501 },
  { label: '#23 👍 は 4', text: THUMBS_UP, expected: 4 },
  { label: '#23 👍🏽（肌の色）は 8', text: THUMBS_UP_MEDIUM_SKIN, expected: 8 },
  { label: '#23 ZWJ で繋いだ家族の絵文字は 25', text: FAMILY, expected: 25 },
  { label: '#23 国旗 🇯🇵 は 8', text: FLAG_JP, expected: 8 },
  { label: '#23 赤いハート（U+2764 U+FE0F）は 6', text: RED_HEART, expected: 6 },
  { label: '#23 キーキャップの 1（U+0031 U+FE0F U+20E3）は 7', text: KEYCAP_ONE, expected: 7 },
  { label: '#23 著作権記号（U+00A9）は 2', text: COPYRIGHT, expected: 2 },
  { label: '#23 タグ列の旗は UTF-8 のバイト数 28', text: FLAG_SCOTLAND, expected: 28 },
  { label: '#24 𠮷（U+20BB7）は UTF-16 の長さ 2', text: CJK_SUPPLEMENTARY, expected: 2 },
  { label: '#24 分解された e ＋ U+0301 は正規化せず 2', text: DECOMPOSED_E_ACUTE, expected: 2 },
  { label: '#24 # は 1', text: '#', expected: 1 },
  { label: '#24 合成済みの U+00E9 は 1', text: '\u00E9', expected: 1 },
  { label: '#24 URL も本文の文字として数える', text: 'https://a.example/x', expected: 19 },
  {
    // こんにちは(5) + 空白(1) + 👍(4) + 空白(1) + 𠮷(2) = 13。
    label: '#23 / #24 絵文字と非絵文字の混在',
    text: `こんにちは ${THUMBS_UP} ${CJK_SUPPLEMENTARY}`,
    expected: 13,
  },
];

/**
 * 対になっていないサロゲート（#29 / #41）。`replaced` は `composeThreadsText` の結果の片割れを U+FFFD に置き換えた文字列。
 */
interface LoneSurrogateCase {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
  readonly replaced: string;
}

const LONE_SURROGATE_CASES: readonly LoneSurrogateCase[] = [
  { label: '上位の片割れだけ（U+D800）', body: '\ud800', link: null, replaced: '\uFFFD' },
  { label: '下位の片割れ（a U+DC00）', body: 'a\udc00', link: null, replaced: 'a\uFFFD' },
  { label: '並びの途中の U+D800', body: 'ab\ud800cd', link: null, replaced: 'ab\uFFFDcd' },
  {
    // link を繋いだ後の文字列を見る（設計 §9.2 の 1）。
    label: 'link の中の U+D800',
    body: 'abc',
    link: 'https://a.example/\ud800',
    replaced: 'abc\nhttps://a.example/\uFFFD',
  },
  {
    label: '逆順に並んだ U+DC00 U+D800（どちらも片割れ）',
    body: 'x\udc00\ud800y',
    link: null,
    replaced: 'x\uFFFD\uFFFDy',
  },
  {
    label: '正しい対の後ろの U+D800（対はそのまま残る）',
    body: '\ud83d\udc4d\ud800',
    link: null,
    replaced: '\ud83d\udc4d\uFFFD',
  },
];

/** 正しいサロゲートの対（👍 = U+1F44D）。 */
const THUMBS_UP_PAIR = '\ud83d\udc4d';

/** intent URL の往復を見る本文と link の組（#39）。 */
const INTENT_CASES: readonly {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
}[] = [
  { label: '日本語だけ', body: 'こんにちは', link: null },
  { label: '& # + % を含む', body: 'A&B #tag 1+1 100%', link: null },
  { label: '改行を含む', body: '一行目\n二行目\r\n三行目', link: null },
  { label: '絵文字と ZWJ 絵文字と国旗', body: `${THUMBS_UP} ${FAMILY} ${FLAG_JP}`, link: null },
  { label: '? = / を含む', body: 'a?b=c/d', link: null },
  { label: 'link を持つ', body: '見てください', link: LINK },
  { label: 'クエリと断片を持つ link', body: '本文', link: 'https://a.example/a?x=1&y=2#frag' },
  { label: '空の本文', body: '', link: null },
];

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

/**
 * 種を固定した擬似乱数（mulberry32）。#25 のランダムな文字列を、落ちたときに再現できるようにする。
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * #25 の材料。**どれも完全なコードポイントの並び**なので、繋いでも対になっていないサロゲートは生まれない。
 * 結合文字・異体字セレクタ・ZWJ・肌の色・タグ文字を単独でも混ぜ、grapheme の区切りが揺れる並びを作る。
 */
const RANDOM_PIECES: readonly string[] = [
  'a',
  'Z',
  '7',
  ' ',
  '\n',
  'あ',
  '漢',
  CJK_SUPPLEMENTARY,
  THUMBS_UP,
  '\u{1F3FD}',
  '\u200D',
  '\u0301',
  '\uFE0F',
  '\u20E3',
  '\u{1F1EF}',
  '\u{1F1F5}',
  '\u{E0067}',
  '\u{E007F}',
  '\u{1F3F4}',
  COPYRIGHT,
  '#',
  '\u2764',
  'https://a.example/x',
  FAMILY,
];

function randomTexts(count: number): readonly string[] {
  const random = seededRandom(20260924);
  return Array.from({ length: count }, () => {
    const length = Math.floor(random() * 60);
    let text = '';
    for (let index = 0; index < length; index += 1) {
      text += RANDOM_PIECES[Math.floor(random() * RANDOM_PIECES.length)] ?? '';
    }
    return text;
  });
}

describe('定数（設計 §9.3）', () => {
  it('本文の上限は 500、リンクの上限は 5', () => {
    expect(THREADS_TEXT_MAX).toBe(500);
    expect(THREADS_LINK_MAX).toBe(5);
  });

  it('Web Intent の宛先は https://www.threads.com/intent/post', () => {
    expect(THREADS_INTENT_BASE_URL).toBe('https://www.threads.com/intent/post');
  });

  it('#82 MANUAL_URL_MAX_LENGTH は Core の EXTERNAL_URL_MAX_LENGTH と一致する（2048）', () => {
    // Plugin は Core の定数を import しないので値を持つ（設計 §9.3）。一致はテスト側で見る。
    expect(MANUAL_URL_MAX_LENGTH).toBe(EXTERNAL_URL_MAX_LENGTH);
    expect(MANUAL_URL_MAX_LENGTH).toBe(2048);
  });
});

describe('countThreadsLength（#22〜#26）', () => {
  it.each(LENGTH_CASES.filter((row) => row.label.startsWith('#22')))(
    '$label → $expected',
    (row) => {
      expect(countThreadsLength(row.text)).toBe(row.expected);
    },
  );

  it.each(LENGTH_CASES.filter((row) => row.label.startsWith('#23')))(
    '$label → $expected',
    (row) => {
      expect(countThreadsLength(row.text)).toBe(row.expected);
    },
  );

  it.each(LENGTH_CASES.filter((row) => row.label.startsWith('#24')))(
    '$label → $expected',
    (row) => {
      expect(countThreadsLength(row.text)).toBe(row.expected);
    },
  );

  it('#23 同じ絵文字を並べると 1 つずつ足される（👍×3 → 12）', () => {
    expect(countThreadsLength(THUMBS_UP.repeat(3))).toBe(12);
  });

  it('#24 正規化しない：分解された e ＋ U+0301 と合成済みの U+00E9 で数えが違う', () => {
    // NFC に寄せると両方 1、NFD に寄せると両方 2 になる。どちらでもないことを見る（設計 §9.4 の 1）。
    expect(countThreadsLength(DECOMPOSED_E_ACUTE)).toBe(2);
    expect(countThreadsLength('\u00E9')).toBe(1);
  });

  it.each(LENGTH_CASES)('#25 表の各行で String.length を下回らない：$label', (row) => {
    expect(countThreadsLength(row.text)).toBeGreaterThanOrEqual(row.text.length);
  });

  it('#25 前提：ランダムな 200 通りの文字列は対になっていないサロゲートを含まない', () => {
    // ここが崩れると #25 が §9.4 の前提（片割れは数えない）の外の入力を見ることになる。
    const texts = randomTexts(200);

    expect(texts).toHaveLength(200);
    for (const text of texts) {
      expect(() => encodeURIComponent(text), JSON.stringify(text)).not.toThrow();
    }
  });

  it('#25 ランダムな 200 通りの文字列で String.length を下回らない', () => {
    for (const text of randomTexts(200)) {
      expect(countThreadsLength(text), JSON.stringify(text)).toBeGreaterThanOrEqual(text.length);
    }
  });

  it('#26 a×496 ＋ 👍 は 500 で、上限に収まる', () => {
    const text = `${'a'.repeat(496)}${THUMBS_UP}`;

    expect(countThreadsLength(text)).toBe(500);
    expect(countThreadsLength(text) <= THREADS_TEXT_MAX).toBe(true);
  });

  it('#26 a×497 ＋ 👍 は 501 で、上限を超える（String.length は 499）', () => {
    const text = `${'a'.repeat(497)}${THUMBS_UP}`;

    expect(text.length).toBe(499);
    expect(countThreadsLength(text)).toBe(501);
    expect(countThreadsLength(text) > THREADS_TEXT_MAX).toBe(true);
  });
});

describe('countThreadsLinks（#27）', () => {
  it.each([
    ['1 本の URL', 'https://a.example/x', 1],
    ['同じ URL を 2 回', 'https://a.example/x https://a.example/x', 1],
    ['http と https は別の URL', 'http://a.example https://a.example', 2],
    ['大文字と小文字の違いは別の URL（多めの側）', 'HTTPS://A.example/ https://a.example/', 2],
    ['末尾の / の違いは別の URL（多めの側）', 'https://a.example https://a.example/', 2],
    ['https:// だけは数えない', 'https://', 0],
    ['http:// だけは数えない', 'http://', 0],
    ['末尾の記号を外して https:// だけになるものは数えない', 'https://).', 0],
    ['https:// の無いドメインは数えない', 'a.example', 0],
    ['URL が無い本文', 'こんにちは', 0],
    ['空文字', '', 0],
    [
      '6 本の異なる URL は 6（上限で切り詰めない）',
      [1, 2, 3, 4, 5, 6].map((n) => `https://a.example/${n}`).join(' '),
      6,
    ],
  ] as const)('#27 %s → %s', (_label, text, expected) => {
    expect(countThreadsLinks(text)).toBe(expected);
  });

  it('#27 「見て https://a.example/x。」は 1 本', () => {
    expect(countThreadsLinks('見て https://a.example/x。')).toBe(1);
  });

  it('#27 URL の直後の「。」を URL に含めない（同じ URL と数える）', () => {
    // 「。」まで URL に含めると、後ろの https://a.example/x と別の URL になり 2 本になる。
    expect(countThreadsLinks('見て https://a.example/x。 https://a.example/x')).toBe(1);
  });

  it('#27 空白なしで日本語が続いても URL は ASCII の並びで終わる（037 中-1）', () => {
    // 「詳しくはhttps://a.example/aをご覧ください」の URL は https://a.example/a。
    expect(countThreadsLinks('詳しくはhttps://a.example/aをご覧ください')).toBe(1);
    expect(countThreadsLinks('詳しくはhttps://a.example/aをご覧ください https://a.example/a')).toBe(
      1,
    );
  });

  it('#27 URL の直後の全角の読点・括弧で URL が終わる', () => {
    expect(countThreadsLinks('https://a.example/a、https://a.example/a')).toBe(1);
    expect(countThreadsLinks('（https://a.example/a）です https://a.example/a')).toBe(1);
  });

  it.each(['.', ',', ';', ':', '!', '?', ')', ']', ').', ']!'])(
    '#27 URL の末尾の %j を外す（同じ URL と数える）',
    (suffix) => {
      expect(countThreadsLinks(`https://a.example/x${suffix} https://a.example/x`)).toBe(1);
    },
  );

  it('#27 クエリと断片は URL に含める', () => {
    expect(countThreadsLinks('https://a.example/a?x=1&y=2#f https://a.example/a?x=1&y=2#f')).toBe(
      1,
    );
    expect(countThreadsLinks('https://a.example/a?x=1 https://a.example/a?x=2')).toBe(2);
  });

  it('#27 composeThreadsText が挟む改行で URL が終わる（本文の末尾の URL と link は別々に数える）', () => {
    const text = composeThreadsText({
      body: '見て https://a.example/x',
      link: 'https://a.example/y',
    });

    expect(countThreadsLinks(text)).toBe(2);
  });

  it('#27 本文の末尾の URL と同じ link は 1 本と数える', () => {
    const text = composeThreadsText({
      body: '見て https://a.example/x',
      link: 'https://a.example/x',
    });

    expect(countThreadsLinks(text)).toBe(1);
  });

  it('同じ関数を続けて呼んでも数が変わらない（正規表現の状態を持ち越さない）', () => {
    const text = 'https://a.example/1 https://a.example/2';

    expect(countThreadsLinks(text)).toBe(2);
    expect(countThreadsLinks(text)).toBe(2);
  });
});

describe('composeThreadsText（#28）', () => {
  it('#28 link が null なら body そのもの', () => {
    expect(composeThreadsText({ body: '本文です', link: null })).toBe('本文です');
  });

  it('#28 link が空文字なら body そのもの', () => {
    expect(composeThreadsText({ body: '本文です', link: '' })).toBe('本文です');
  });

  it('#28 link が undefined なら body そのもの', () => {
    expect(composeThreadsText({ body: '本文です', link: undefined })).toBe('本文です');
  });

  it('#28 link があれば body ＋ 改行 ＋ link', () => {
    expect(composeThreadsText({ body: '本文です', link: LINK })).toBe(`本文です\n${LINK}`);
  });

  it('#28 body が文字列でなくても例外を投げず、空文字として扱う', () => {
    for (const body of [123, null, undefined, { a: 1 }, ['x'], true]) {
      expect(() => composeThreadsText({ body, link: null })).not.toThrow();
      expect(composeThreadsText({ body, link: null })).toBe('');
    }
  });

  it('#28 link が文字列でなくても例外を投げず、足さない', () => {
    for (const link of [42, { href: LINK }, [LINK], true]) {
      expect(() => composeThreadsText({ body: '本文です', link })).not.toThrow();
      expect(composeThreadsText({ body: '本文です', link })).toBe('本文です');
    }
  });
});

describe('hasLoneSurrogate（#29）', () => {
  it.each([
    ['U+D800 だけ', '\ud800'],
    ['a の後の U+DC00', 'a\udc00'],
    ['並びの途中の U+D800', 'ab\ud800cd'],
    ['逆順の U+DC00 U+D800', 'x\udc00\ud800y'],
    ['正しい対の後ろの U+D800', '\ud83d\udc4d\ud800'],
    ['末尾の U+DBFF', 'abc\udbff'],
  ])('#29 %s → true', (_label, text) => {
    expect(hasLoneSurrogate(text)).toBe(true);
  });

  it('#29 link の中の片割れも、繋いだ後の文字列で見つかる', () => {
    const text = composeThreadsText({ body: 'abc', link: 'https://a.example/\ud800' });

    expect(hasLoneSurrogate(text)).toBe(true);
  });

  it.each([
    ['👍（正しい対）', THUMBS_UP_PAIR],
    ['ZWJ で繋いだ家族の絵文字', FAMILY],
    ['𠮷', CJK_SUPPLEMENTARY],
    ['日本語', 'あいう'],
    ['空文字', ''],
  ])('#29 %s → false', (_label, text) => {
    expect(hasLoneSurrogate(text)).toBe(false);
  });

  it('同じ関数を続けて呼んでも結果が変わらない（正規表現の状態を持ち越さない）', () => {
    expect(hasLoneSurrogate('a\ud800')).toBe(true);
    expect(hasLoneSurrogate('a\ud800')).toBe(true);
    expect(hasLoneSurrogate('ok')).toBe(false);
  });
});

describe('buildThreadsIntentUrl（#39 / #41）', () => {
  it('#39 https://www.threads.com/intent/post?text= ＋ encodeURIComponent(composeThreadsText(post))', () => {
    const post = { body: 'A&B', link: LINK };

    expect(buildThreadsIntentUrl(post)).toBe(
      `${INTENT_PREFIX}${encodeURIComponent(`A&B\n${LINK}`)}`,
    );
  });

  it.each(INTENT_CASES)('#39 等式が成り立つ：$label', (row) => {
    expect(buildThreadsIntentUrl(row)).toBe(
      `${INTENT_PREFIX}${encodeURIComponent(composeThreadsText(row))}`,
    );
  });

  it('#39 url= も tag= も含まない（link も text に入る）', () => {
    const built = buildThreadsIntentUrl({ body: '本文です', link: LINK });
    const url = new URL(built);

    expect([...url.searchParams.keys()]).toEqual(['text']);
    expect(url.search).not.toContain('url=');
    expect(url.search).not.toContain('tag=');
  });

  it.each(INTENT_CASES)('#39 searchParams の text が composeThreadsText に戻る：$label', (row) => {
    const url = new URL(buildThreadsIntentUrl(row));

    expect(url.origin + url.pathname).toBe('https://www.threads.com/intent/post');
    expect(url.hash).toBe('');
    expect(url.searchParams.get('text')).toBe(composeThreadsText(row));
  });

  it('#39 & # + % 改行 絵文字をまとめて含んでも text が戻る', () => {
    const post = { body: `A&B #tag 1+1 100%\n二行目 ${FAMILY} ${FLAG_JP} ? =`, link: LINK };
    const url = new URL(buildThreadsIntentUrl(post));

    expect(url.searchParams.get('text')).toBe(`${post.body}\n${LINK}`);
  });

  it('#39 日本語 223 文字の本文で intent URL はちょうど 2048 文字（1 文字 9 文字に符号化）', () => {
    // #32 の境界の前提（実装プラン §8 の 16）。
    expect(buildThreadsIntentUrl({ body: 'あ'.repeat(223), link: null })).toHaveLength(2048);
    expect(buildThreadsIntentUrl({ body: `${'あ'.repeat(223)}a`, link: null })).toHaveLength(2049);
  });

  it('#41 前提：表の本文（link を繋いだ後）は片割れを含み、encodeURIComponent がそのままでは投げる', () => {
    // ここが崩れると、以下のテストが「例外を投げない」ことを確かめなくなる。
    for (const row of LONE_SURROGATE_CASES) {
      expect(() => encodeURIComponent(composeThreadsText(row)), row.label).toThrow(URIError);
    }
  });

  it.each(LONE_SURROGATE_CASES)(
    '#41 片割れがあっても例外を投げず、text が片割れを U+FFFD に置き換えた文字列に戻る：$label',
    (row) => {
      expect(() => buildThreadsIntentUrl(row)).not.toThrow();
      const url = new URL(buildThreadsIntentUrl(row));

      expect(url.origin + url.pathname).toBe('https://www.threads.com/intent/post');
      expect(url.searchParams.get('text')).toBe(row.replaced);
    },
  );

  it('#41 正しいサロゲートの対（👍）は U+FFFD に置き換えない', () => {
    const post = { body: `いいね${THUMBS_UP_PAIR}`, link: LINK };

    expect(new URL(buildThreadsIntentUrl(post)).searchParams.get('text')).toBe(
      `いいね${THUMBS_UP_PAIR}\n${LINK}`,
    );
  });

  it('#39 body / link が文字列でなくても例外を投げない', () => {
    for (const post of [
      { body: 123, link: null },
      { body: null, link: 42 },
      { body: undefined, link: { href: LINK } },
    ]) {
      expect(() => buildThreadsIntentUrl(post)).not.toThrow();
      expect(buildThreadsIntentUrl(post).startsWith(INTENT_PREFIX)).toBe(true);
    }
  });
});

describe('THREADS_MANUAL_NOTE と buildThreadsManualHandoff', () => {
  it('buildThreadsManualHandoff は { url: buildThreadsIntentUrl(post), note: THREADS_MANUAL_NOTE } ちょうど', () => {
    const post = { body: '本文です', link: LINK };

    expect(buildThreadsManualHandoff(post)).toStrictEqual({
      url: buildThreadsIntentUrl(post),
      note: THREADS_MANUAL_NOTE,
    });
  });

  it.each(LONE_SURROGATE_CASES)(
    '#41 buildThreadsManualHandoff も片割れで例外を投げない：$label',
    (row) => {
      expect(() => buildThreadsManualHandoff(row)).not.toThrow();
      expect(buildThreadsManualHandoff(row).url).toBe(buildThreadsIntentUrl(row));
    },
  );
});

it('#107 どの関数も fetch を呼ばない', () => {
  for (const row of INTENT_CASES) {
    const text = composeThreadsText(row);
    countThreadsLength(text);
    countThreadsLinks(text);
    hasLoneSurrogate(text);
    buildThreadsManualHandoff(row);
  }
  for (const row of LONE_SURROGATE_CASES) {
    hasLoneSurrogate(composeThreadsText(row));
    buildThreadsManualHandoff(row);
  }

  expect(fetchCalls).toBe(0);
});
