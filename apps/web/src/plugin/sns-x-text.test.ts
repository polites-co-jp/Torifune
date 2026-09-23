import type { PublisherValidationProblem } from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTERNAL_URL_MAX_LENGTH, isValidManualUrl } from '@/domain/social/social';
import * as apiText from '../../../../plugins/sns-x-api/x-text';
import * as manualText from '../../../../plugins/sns-x-manual/x-text';

/**
 * X 配信 Plugin の `x-text.ts` の単体検査（037-sns-x 設計 §9.4 / §10.3）。
 *
 * **`x-text.ts` は `sns-x-manual` と `sns-x-api` にバイト単位で同じ内容で置く**（設計 §4.2）。
 * ここでは**同じ表を 2 つの写しの両方に掛ける**（`describe.each`）。
 * バイト単位の一致そのものは `sns-x-static-checks.test.ts` の #9 が見る。
 *
 * 担当する受け入れ条件：#13〜#21、#62（URL の長さの側）。
 *
 * #89：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

type XTextModule = typeof manualText;

const COPIES: readonly (readonly [string, XTextModule])[] = [
  ['sns-x-manual', manualText],
  ['sns-x-api', apiText],
];

/** Web Intent の URL の前半（設計 §9.4）。長さの計算にだけ使う。 */
const INTENT_PREFIX = 'https://x.com/intent/tweet?text=';

/** 本文中に置く URL の頭。`encodeURIComponent` すると 28 文字になる。 */
const URL_HEAD = 'https://example.com/';

const LINK = 'https://example.com/a';

/** ZWJ で繋いだ絵文字（4 人家族）。1 grapheme、7 コードポイント。 */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

/**
 * intent URL の全長がちょうど `target` 文字になる本文（URL 1 本だけ。重みは 23）。
 *
 * 重み付きの長さは URL の長さによらず 23 なので、**重みは 280 以内のまま intent URL だけが長くなる**（設計 §9.2 の 3）。
 */
function bodyWithIntentLength(target: number): string {
  const fixed = INTENT_PREFIX.length + encodeURIComponent(URL_HEAD).length;
  return URL_HEAD + 'a'.repeat(target - fixed);
}

interface TextCase {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
  /** `composeXText` した文字列の重み付きの長さ。 */
  readonly weight: number;
  /** `deliveryMode: 'manual'` のときに `checkXText` が返す `field` の列。 */
  readonly manual: readonly string[];
  /** `deliveryMode: 'auto'` のときに `checkXText` が返す `field` の列。 */
  readonly auto: readonly string[];
}

/**
 * **このファイルの表はこれ 1 つだけ**（実装プラン §2「テストの方法」）。
 * #13〜#15 の数え方、#18 / #19 の判定、#17 の往復、#20 の URL の検査がすべてここから引く。
 */
const CASES: readonly TextCase[] = [
  { label: '#13 a×280', body: 'a'.repeat(280), link: null, weight: 280, manual: [], auto: [] },
  {
    label: '#13 a×281',
    body: 'a'.repeat(281),
    link: null,
    weight: 281,
    manual: ['body'],
    auto: ['body'],
  },
  { label: '#13 あ×140', body: 'あ'.repeat(140), link: null, weight: 280, manual: [], auto: [] },
  {
    label: '#13 あ×141',
    body: 'あ'.repeat(141),
    link: null,
    weight: 282,
    manual: ['body'],
    auto: ['body'],
  },
  { label: '#13 👍', body: '👍', link: null, weight: 2, manual: [], auto: [] },
  { label: '#13 ZWJ で繋いだ絵文字', body: FAMILY, link: null, weight: 2, manual: [], auto: [] },
  { label: '#13 国旗 🇯🇵', body: '🇯🇵', link: null, weight: 2, manual: [], auto: [] },
  { label: '#13 👍×140', body: '👍'.repeat(140), link: null, weight: 280, manual: [], auto: [] },
  {
    label: '#13 👍×141',
    body: '👍'.repeat(141),
    link: null,
    weight: 282,
    manual: ['body'],
    auto: ['body'],
  },
  {
    // 重みは 280 ちょうどでも、エンコードすると 1 つ 75 文字になり intent URL が 2048 を超える。
    label: '#13 ZWJ で繋いだ絵文字×140（intent URL が 2048 を超える）',
    body: FAMILY.repeat(140),
    link: null,
    weight: 280,
    manual: ['body'],
    auto: [],
  },
  {
    label: '#14 2000 文字を超える URL は 23',
    body: `${URL_HEAD}${'a'.repeat(2000)}`,
    link: null,
    weight: 23,
    manual: ['body'],
    auto: [],
  },
  {
    // 2*2（見て）+ 1（空白）+ 23（URL）+ 2（。）。末尾の「。」を URL に含めない。
    label: '#14 末尾の「。」を URL に含めない',
    body: '見て https://example.com/x。',
    link: null,
    weight: 30,
    manual: [],
    auto: [],
  },
  {
    label: '#14 http:// の URL も 23',
    body: `http://example.com/${'b'.repeat(100)}`,
    link: null,
    weight: 23,
    manual: [],
    auto: [],
  },
  /*
   * #14 の続き：**URL は ASCII の表示文字の並びで終わる**（設計 §9.4 の 2。2026-09-23 の訂正）。
   * 日本語の文では URL の直後に空白を置かないことが多い。空白までを URL とすると、後ろの日本語が 23 に潰れる。
   */
  {
    // 見て(2*2) + URL 23 + をご覧ください(2*7) = 41。
    label: '#14 URL の直後に空白なしで日本語が続いても、日本語は URL に含めない',
    body: '見てhttps://example.com/aをご覧ください',
    link: null,
    weight: 41,
    manual: [],
    auto: [],
  },
  {
    // 詳しくは(2*4) + URL 23 + をご覧ください(2*7) + あ×200(400) = 445。初版の規則では 31 と数えていた（検証の中-1）。
    label: '#14 検証の例：URL の後ろの日本語 207 文字を 23 に潰さず 445 と数える',
    body: `詳しくはhttps://example.com/aをご覧ください${'あ'.repeat(200)}`,
    link: null,
    weight: 445,
    manual: ['body'],
    auto: ['body'],
  },
  {
    // URL 23 + 、(2) + 次へ(2*2) + 。(2) = 31。
    label: '#14 URL の直後の全角の読点・句点を URL に含めない',
    body: 'https://example.com/a、次へ。',
    link: null,
    weight: 31,
    manual: [],
    auto: [],
  },
  {
    // （(2) + URL 23 + ）(2) + です(2*2) = 31。
    label: '#14 全角の括弧で囲んだ URL の閉じ括弧を URL に含めない',
    body: '（https://example.com/a）です',
    link: null,
    weight: 31,
    manual: [],
    auto: [],
  },
  {
    // 見て(2*2) + 空白 1 + URL 23 + )(1) + .(1) = 30。ASCII の句読点・閉じ括弧は従来どおり末尾から外す。
    label: '#14 URL の末尾の ASCII の閉じ括弧と句点を外す',
    body: '見て https://example.com/x).',
    link: null,
    weight: 30,
    manual: [],
    auto: [],
  },
  {
    // URL 23 + 日本語(2*3) = 29。
    label: '#14 URL の後ろの CJK は 2 ずつ数える',
    body: 'https://example.com/日本語',
    link: null,
    weight: 29,
    manual: [],
    auto: [],
  },
  {
    // URL 23 + 👍(2) + ok(2) = 27。
    label: '#14 URL の直後の絵文字は URL に含めず 2 と数える',
    body: 'https://example.com/a👍ok',
    link: null,
    weight: 27,
    manual: [],
    auto: [],
  },
  {
    // 設計 §11 #3 (b)①：twitter-text は 23。ここでは全体を平文として 8 + 日本(2*2) + .jp(3) = 15。
    label: '#14（§11 #3 の b①）国際化ドメイン名は URL と数えない',
    body: 'https://日本.jp',
    link: null,
    weight: 15,
    manual: [],
    auto: [],
  },
  {
    // 設計 §11 #3 (b)②：twitter-text は path に含めて 23。ここでは URL 23 + é(1) + /menu(5) = 29。
    label: '#14（§11 #3 の b②）path のラテン文字の拡張の所で URL を終える',
    body: 'https://example.com/caf\u00e9/menu',
    link: null,
    weight: 29,
    manual: [],
    auto: [],
  },
  {
    label: '#15 分解された é は NFC で 1',
    body: 'e\u0301',
    link: null,
    weight: 1,
    manual: [],
    auto: [],
  },
  { label: '#15 U+2014（—）は 1', body: '\u2014', link: null, weight: 1, manual: [], auto: [] },
  { label: '#15 U+2026（…）は 2', body: '\u2026', link: null, weight: 2, manual: [], auto: [] },
  { label: '#15 U+2033（″）は 1', body: '\u2033', link: null, weight: 1, manual: [], auto: [] },
  {
    label: '#15 半角カナ U+FF71 は 2',
    body: '\uFF71',
    link: null,
    weight: 2,
    manual: [],
    auto: [],
  },
  {
    // 257 + 改行 1 + link 23 = 281。
    label: '#18 本文 257 ＋ link は 281',
    body: 'a'.repeat(257),
    link: LINK,
    weight: 281,
    manual: ['body'],
    auto: ['body'],
  },
  {
    label: '#18 本文 256 ＋ link は 280',
    body: 'a'.repeat(256),
    link: LINK,
    weight: 280,
    manual: [],
    auto: [],
  },
  {
    label: '#19 intent URL が 2049 文字',
    body: bodyWithIntentLength(2049),
    link: null,
    weight: 23,
    manual: ['body'],
    auto: [],
  },
  {
    label: '#19 intent URL が 2048 文字ちょうど',
    body: bodyWithIntentLength(2048),
    link: null,
    weight: 23,
    manual: [],
    auto: [],
  },
  { label: '空の本文', body: '', link: null, weight: 0, manual: [], auto: [] },
  {
    // A&B(3) 空白(1) #tag(4) 空白(1) 1+1(3) 空白(1) 100%(4) 改行(1) 改行(2*2)
    label: '& # + % と改行',
    body: 'A&B #tag 1+1 100%\n改行',
    link: null,
    weight: 22,
    manual: [],
    auto: [],
  },
  {
    // 2*128 + 1 + 23 = 280。
    label: '日本語と URL で 280 ちょうど',
    body: `${'あ'.repeat(128)} ${URL_HEAD}${'p'.repeat(300)}`,
    link: null,
    weight: 280,
    manual: [],
    auto: [],
  },
  {
    // こんにちは(2*5) + 改行 1 + link 23 = 34。
    label: 'クエリと断片を持つ link',
    body: 'こんにちは',
    link: 'https://example.com/a?x=1&y=2#frag',
    weight: 34,
    manual: [],
    auto: [],
  },
];

/**
 * #93：対になっていないサロゲートを含む本文（設計 §9.4 / §10.16）。
 * `replaced` は `composeXText` の結果の片割れを U+FFFD に置き換えた文字列（intent URL の `text` が戻る先）。
 */
interface LoneSurrogateCase {
  readonly label: string;
  readonly body: string;
  readonly link: string | null;
  readonly replaced: string;
}

const LONE_SURROGATE_CASES: readonly LoneSurrogateCase[] = [
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
  {
    label: '逆順に並んだ U+DC00 U+D800（どちらも片割れ）',
    body: 'x\udc00\ud800y',
    link: null,
    replaced: 'x\ufffd\ufffdy',
  },
  {
    label: '正しい対の後ろの U+D800（対はそのまま残る）',
    body: '\ud83d\udc4d\ud800',
    link: null,
    replaced: '\ud83d\udc4d\ufffd',
  },
];

/** #93 の文言（設計 §9.4）。 */
const LONE_SURROGATE_MESSAGE = '本文に扱えない文字が含まれています。';

/** 正しいサロゲートの対（👍 = U+1F44D）。 */
const THUMBS_UP_PAIR = '\ud83d\udc4d';

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

function fieldsOf(problems: readonly PublisherValidationProblem[]): string[] {
  return problems.map((problem) => problem.field);
}

function casesFor(criterion: string): readonly TextCase[] {
  return CASES.filter((row) => row.label.startsWith(criterion));
}

describe('表の前提', () => {
  it('#19 の本文は intent URL がちょうど 2049 / 2048 文字になる', () => {
    // 表の組み立てを確かめる（ここが崩れると #19 が境界を見なくなる）。
    const [over, exact] = casesFor('#19');

    expect(INTENT_PREFIX.length + encodeURIComponent(over?.body ?? '').length).toBe(2049);
    expect(INTENT_PREFIX.length + encodeURIComponent(exact?.body ?? '').length).toBe(2048);
  });

  it('#62 MANUAL_URL_MAX_LENGTH は Core の EXTERNAL_URL_MAX_LENGTH と一致する', () => {
    // Plugin は Core の定数を import しないので値を持つ（設計 §9.4）。一致はテスト側で見る。
    expect(manualText.MANUAL_URL_MAX_LENGTH).toBe(EXTERNAL_URL_MAX_LENGTH);
    expect(apiText.MANUAL_URL_MAX_LENGTH).toBe(EXTERNAL_URL_MAX_LENGTH);
  });
});

describe.each(COPIES)('%s/x-text.ts', (_name, text) => {
  function check(row: TextCase, deliveryMode: 'manual' | 'auto') {
    return text.checkXText({ body: row.body, link: row.link, deliveryMode });
  }

  describe('定数（設計 §9.4）', () => {
    it('重みの上限は 280、URL の重みは 23、intent の宛先は https://x.com/intent/tweet', () => {
      expect(text.X_WEIGHTED_LENGTH_MAX).toBe(280);
      expect(text.X_URL_WEIGHT).toBe(23);
      expect(text.X_INTENT_BASE_URL).toBe('https://x.com/intent/tweet');
      expect(text.MANUAL_URL_MAX_LENGTH).toBe(2048);
    });
  });

  describe('countXWeightedLength（#13〜#15）', () => {
    it.each(casesFor('#13'))('$label → $weight', (row) => {
      expect(text.countXWeightedLength(row.body)).toBe(row.weight);
    });

    it.each(casesFor('#14'))('$label → $weight', (row) => {
      expect(text.countXWeightedLength(row.body)).toBe(row.weight);
    });

    it.each(casesFor('#15'))('$label → $weight', (row) => {
      expect(text.countXWeightedLength(row.body)).toBe(row.weight);
    });

    it.each(CASES)('表の各行で composeXText した文字列の重みが期待どおり：$label', (row) => {
      expect(text.countXWeightedLength(text.composeXText(row))).toBe(row.weight);
    });
  });

  describe('composeXText（#16）', () => {
    it('#16 link が null なら body そのもの', () => {
      expect(text.composeXText({ body: '本文です', link: null })).toBe('本文です');
    });

    it('#16 link があれば body + 改行 + link', () => {
      expect(text.composeXText({ body: '本文です', link: LINK })).toBe(`本文です\n${LINK}`);
    });

    it('#16 link が undefined なら body そのもの', () => {
      expect(text.composeXText({ body: '本文です', link: undefined })).toBe('本文です');
    });

    it('#16 link が空文字なら足さない（実装プラン §8 の 9）', () => {
      expect(text.composeXText({ body: '本文です', link: '' })).toBe('本文です');
    });

    it('#16 body が文字列でなくても例外を投げず、空文字として扱う', () => {
      for (const body of [123, null, undefined, { a: 1 }, ['x']]) {
        expect(() => text.composeXText({ body, link: null })).not.toThrow();
        expect(text.composeXText({ body, link: null })).toBe('');
      }
    });

    it('#16 link が文字列でなくても例外を投げず、足さない', () => {
      for (const link of [42, { href: LINK }, [LINK], true]) {
        expect(() => text.composeXText({ body: '本文です', link })).not.toThrow();
        expect(text.composeXText({ body: '本文です', link })).toBe('本文です');
      }
    });
  });

  describe('buildXIntentUrl（#17）', () => {
    it('#17 https://x.com/intent/tweet?text= ＋ encodeURIComponent(composeXText(post))', () => {
      const post = { body: 'A&B', link: LINK };

      expect(text.buildXIntentUrl(post)).toBe(
        `https://x.com/intent/tweet?text=${encodeURIComponent(`A&B\n${LINK}`)}`,
      );
    });

    it('#17 url= の引数を使わない（link も text に入る）', () => {
      const url = new URL(text.buildXIntentUrl({ body: '本文です', link: LINK }));

      expect([...url.searchParams.keys()]).toEqual(['text']);
      expect(url.search).not.toContain('url=');
    });

    it.each(CASES)('#17 searchParams の text が composeXText に戻る：$label', (row) => {
      const url = new URL(text.buildXIntentUrl(row));

      expect(url.searchParams.get('text')).toBe(text.composeXText(row));
    });

    it('#17 & # + % 改行 絵文字を含んでも text が戻る', () => {
      const post = { body: `A&B #tag 1+1 100%\n二行目 ${FAMILY} 🇯🇵 ? =`, link: LINK };
      const url = new URL(text.buildXIntentUrl(post));

      expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
      expect(url.hash).toBe('');
      expect(url.searchParams.get('text')).toBe(`${post.body}\n${LINK}`);
    });
  });

  describe('checkXText（#18 / #19）', () => {
    it('#18 重み 280 なら問題なし', () => {
      expect(check(casesFor('#13 a×280')[0] as TextCase, 'auto')).toEqual([]);
    });

    it('#18 重み 281 なら body の問題が 1 件', () => {
      expect(fieldsOf(check(casesFor('#13 a×281')[0] as TextCase, 'auto'))).toEqual(['body']);
    });

    it('#18 文言に上限の 280 と現在の値が現れる', () => {
      const [problem] = check(casesFor('#13 あ×141')[0] as TextCase, 'auto');

      expect(problem?.message ?? '').toContain('280');
      expect(problem?.message ?? '').toContain('282');
    });

    it('#18 link の 23 と改行 1 を含めて数える（本文 257 ＋ link で 281）', () => {
      for (const deliveryMode of ['auto', 'manual'] as const) {
        const problems = text.checkXText({ body: 'a'.repeat(257), link: LINK, deliveryMode });

        expect(fieldsOf(problems), deliveryMode).toEqual(['body']);
      }
    });

    it('#18 本文 256 ＋ link なら 280 で問題なし', () => {
      for (const deliveryMode of ['auto', 'manual'] as const) {
        expect(
          text.checkXText({ body: 'a'.repeat(256), link: LINK, deliveryMode }),
          deliveryMode,
        ).toEqual([]);
      }
    });

    it('#19 manual で intent URL が 2049 文字なら body の問題（重みは 280 以内）', () => {
      const row = casesFor('#19 intent URL が 2049')[0] as TextCase;

      expect(text.countXWeightedLength(row.body)).toBeLessThanOrEqual(280);
      expect(text.buildXIntentUrl(row)).toHaveLength(2049);
      expect(fieldsOf(check(row, 'manual'))).toEqual(['body']);
    });

    it('#19 manual で intent URL が 2048 文字ちょうどなら問題なし', () => {
      const row = casesFor('#19 intent URL が 2048')[0] as TextCase;

      expect(text.buildXIntentUrl(row)).toHaveLength(2048);
      expect(check(row, 'manual')).toEqual([]);
    });

    it('#19 auto では同じ本文でも intent URL の長さを問題にしない', () => {
      const row = casesFor('#19 intent URL が 2049')[0] as TextCase;

      expect(check(row, 'auto')).toEqual([]);
    });

    it.each(CASES)('#18 / #19 manual の判定が表どおり：$label', (row) => {
      expect(fieldsOf(check(row, 'manual'))).toEqual(row.manual);
    });

    it.each(CASES)('#18 / #19 auto の判定が表どおり：$label', (row) => {
      expect(fieldsOf(check(row, 'auto'))).toEqual(row.auto);
    });

    it('#18 body / link / deliveryMode が壊れていても例外を投げない', () => {
      for (const post of [
        { body: 123, link: null, deliveryMode: 'manual' },
        { body: null, link: 42, deliveryMode: undefined },
        { body: undefined, link: { href: LINK }, deliveryMode: 7 },
      ]) {
        expect(() => text.checkXText(post)).not.toThrow();
      }
    });

    it('#18 同期で配列を返す', () => {
      const result = text.checkXText({ body: 'こんにちは', link: null, deliveryMode: 'manual' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).not.toBeInstanceOf(Promise);
    });
  });

  describe('Core の isValidManualUrl（#20）', () => {
    it.each(CASES.filter((row) => row.manual.length === 0))(
      '#20 checkXText が [] を返す行の intent URL は isValidManualUrl に通る：$label',
      (row) => {
        expect(isValidManualUrl(text.buildXIntentUrl(row))).toBe(true);
      },
    );
  });

  describe('X_MANUAL_NOTE と buildXManualHandoff（#21）', () => {
    it('#21 注意書きに「画像」と「投稿画面」が含まれる', () => {
      expect(text.X_MANUAL_NOTE).toContain('画像');
      expect(text.X_MANUAL_NOTE).toContain('投稿画面');
    });

    it('#21 添付を断定しない（「添える場合は」を含む）', () => {
      // 手動投稿に media は付けられない（Core が 422）。「画像は投稿画面で添付してください。」と書くと
      // 付けたはずの画像が落ちたと読まれる（設計 §9.5）。
      expect(text.X_MANUAL_NOTE).toContain('添える場合は');
      expect(text.X_MANUAL_NOTE).not.toMatch(/画像は[^。]*添付してください/);
    });

    it('buildXManualHandoff は { url: buildXIntentUrl(post), note: X_MANUAL_NOTE } ちょうど', () => {
      const post = { body: '本文です', link: LINK };

      expect(text.buildXManualHandoff(post)).toEqual({
        url: text.buildXIntentUrl(post),
        note: text.X_MANUAL_NOTE,
      });
    });
  });

  describe('対になっていないサロゲート（#93）', () => {
    it('前提：表の本文（link を繋いだ後）は対になっていないサロゲートを含み、encodeURIComponent がそのままでは投げる', () => {
      // ここが崩れると、以下のテストが「例外を投げない」ことを確かめなくなる。
      for (const row of LONE_SURROGATE_CASES) {
        expect(() => encodeURIComponent(text.composeXText(row)), row.label).toThrow(URIError);
      }
      expect(() => encodeURIComponent(THUMBS_UP_PAIR)).not.toThrow();
    });

    it.each(LONE_SURROGATE_CASES)(
      '#93 checkXText は manual でも例外を投げず [{ field: body }] を返す：$label',
      (row) => {
        const post = { body: row.body, link: row.link, deliveryMode: 'manual' };

        expect(() => text.checkXText(post)).not.toThrow();
        expect(text.checkXText(post)).toEqual([{ field: 'body', message: LONE_SURROGATE_MESSAGE }]);
      },
    );

    it.each(LONE_SURROGATE_CASES)(
      '#93 checkXText は auto でも例外を投げず [{ field: body }] を返す（X へ送っても受け付けられない）：$label',
      (row) => {
        const post = { body: row.body, link: row.link, deliveryMode: 'auto' };

        expect(() => text.checkXText(post)).not.toThrow();
        expect(text.checkXText(post)).toEqual([{ field: 'body', message: LONE_SURROGATE_MESSAGE }]);
      },
    );

    it('#93 片割れのある本文では intent URL の長さを数えない（長い URL を含んでも問題は 1 件）', () => {
      // intent URL が 2048 を超える本文に片割れを足す。長さの問題は重ねない（設計 §9.4）。
      const body = `${bodyWithIntentLength(2100)} \ud800`;

      expect(text.checkXText({ body, link: null, deliveryMode: 'manual' })).toEqual([
        { field: 'body', message: LONE_SURROGATE_MESSAGE },
      ]);
    });

    it.each(LONE_SURROGATE_CASES)(
      '#93 buildXIntentUrl は例外を投げず、text が片割れを U+FFFD に置き換えた文字列に戻る：$label',
      (row) => {
        expect(() => text.buildXIntentUrl(row)).not.toThrow();
        const url = new URL(text.buildXIntentUrl(row));

        expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
        expect(url.searchParams.get('text')).toBe(row.replaced);
      },
    );

    it.each(LONE_SURROGATE_CASES)(
      '#93 buildXManualHandoff も例外を投げず、url は buildXIntentUrl と同じ：$label',
      (row) => {
        expect(() => text.buildXManualHandoff(row)).not.toThrow();
        expect(text.buildXManualHandoff(row)).toEqual({
          url: text.buildXIntentUrl(row),
          note: text.X_MANUAL_NOTE,
        });
      },
    );

    it('#93 正しいサロゲートの対（👍）は問題にしない（manual / auto）', () => {
      for (const deliveryMode of ['manual', 'auto'] as const) {
        expect(
          text.checkXText({ body: `いいね${THUMBS_UP_PAIR}`, link: null, deliveryMode }),
          deliveryMode,
        ).toEqual([]);
      }
    });

    it('#93 正しいサロゲートの対（👍）は U+FFFD に置き換えない', () => {
      const post = { body: `いいね${THUMBS_UP_PAIR}`, link: LINK };

      expect(new URL(text.buildXIntentUrl(post)).searchParams.get('text')).toBe(
        `いいね${THUMBS_UP_PAIR}\n${LINK}`,
      );
      // #17 の等式は正しい文字列では変わらない。
      expect(text.buildXIntentUrl(post)).toBe(
        `https://x.com/intent/tweet?text=${encodeURIComponent(text.composeXText(post))}`,
      );
    });
  });

  it('#89 どの関数も fetch を呼ばない', () => {
    for (const row of CASES) {
      text.checkXText({ ...row, deliveryMode: 'manual' });
      text.buildXManualHandoff(row);
    }

    expect(fetchCalls).toBe(0);
  });
});
