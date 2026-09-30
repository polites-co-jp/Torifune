import { describe, expect, it } from 'vitest';
import {
  containsLoneSurrogate,
  containsNul,
  LONE_SURROGATE_MESSAGE,
  NUL_MESSAGE,
  toStorableText,
  unusableTextDetailsOf,
} from './text';

/**
 * 文字の規則の純関数（046-input-500-nul-and-ranges 設計 §4.1・§6.2、受け入れ条件 #1〜#5）。
 *
 * - NUL（U+0000）と対になっていないサロゲート（片割れ）は保存できない文字として断る
 * - 422 の `details` のキーは、使えない文字を含む値がある**最上位の項目名**（最上位のキー自体・本文がオブジェクトでないときは `_`）
 * - 文言は NUL と片割れで分ける。同じ項目に両方あれば NUL が先の 2 つ
 * - `toStorableText`（L4）は NUL と片割れを U+FFFD に置き換え、UTF-16 の長さを変えない
 *
 * **ソースに壊れた文字を置かない**（実装プラン §7 の 5）。NUL と片割れは `\u0000`・`\ud800` のエスケープで書き、
 * U+FFFD と絵文字（対になったサロゲート）は `String.fromCodePoint` で作る。
 */

const REPLACEMENT = String.fromCodePoint(0xfffd);
/** U+1F44D。UTF-16 では対になったサロゲート（`👍`）。片割れではない。 */
const EMOJI = String.fromCodePoint(0x1f44d);

const NUL_TEXT = '使用できない文字（NUL）が含まれています。';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';

/* -------------------------------------------------------------------------- */
/* #1 containsNul                                                               */
/* -------------------------------------------------------------------------- */

describe('#1 containsNul は NUL（U+0000）を含む文字列だけを真にする', () => {
  it.each([
    ['空文字', ''],
    ['通常の文字列', 'abc'],
    ['NUL 以外の制御文字（U+0001）', 'a\u0001'],
    ['絵文字（対になったサロゲート）', EMOJI],
    ['片割れ（NUL ではない）', 'a\ud800'],
  ])('#1 %s → 偽', (_label, value) => {
    expect(containsNul(value)).toBe(false);
  });

  it.each([
    ['NUL だけ', '\u0000'],
    ['途中の NUL', 'a\u0000b'],
    ['末尾の NUL', 'abc\u0000'],
  ])('#1 %s → 真', (_label, value) => {
    expect(containsNul(value)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #2 containsLoneSurrogate                                                     */
/* -------------------------------------------------------------------------- */

describe('#2 containsLoneSurrogate は対になっていないサロゲートを含む文字列だけを真にする', () => {
  it.each([
    ['途中の上位サロゲート', 'a\ud800b'],
    ['下位サロゲートだけ', '\udc00'],
    ['先頭の上位サロゲート（後ろが下位でない）', '\ud800abc'],
    ['末尾の上位サロゲート', 'x\ud83d'],
    ['下位が先に来る逆順', '\ude00\ud83d'],
    ['絵文字の直後の上位サロゲート', `${EMOJI}\ud800`],
    ['絵文字の直前の下位サロゲート', `\udc00${EMOJI}`],
    ['上位サロゲートが 2 つ続く（後ろは末尾で対が無い）', '\ud800\ud800'],
  ])('#2 %s → 真', (_label, value) => {
    expect(containsLoneSurrogate(value)).toBe(true);
  });

  it.each([
    ['空文字', ''],
    ['通常の文字列', 'abc'],
    ['絵文字（対になったサロゲート）', EMOJI],
    ['絵文字が 2 つ続く', `${EMOJI}${EMOJI}`],
    ['日本語と絵文字', `とりふね${EMOJI}です`],
    ['NUL（片割れではない）', '\u0000'],
  ])('#2 %s → 偽', (_label, value) => {
    expect(containsLoneSurrogate(value)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #3 unusableTextDetailsOf                                                     */
/* -------------------------------------------------------------------------- */

describe('#3 unusableTextDetailsOf は使えない文字を含む最上位の項目名 → 文言を返す', () => {
  it('#3 NUL を含む項目だけがキーになり、値は NUL の文言', () => {
    expect(unusableTextDetailsOf({ a: 'x', b: 'y\u0000' })).toEqual({ b: [NUL_TEXT] });
  });

  it('#3 片割れを含む項目の値はサロゲートの文言', () => {
    expect(unusableTextDetailsOf({ b: 'y\ud800' })).toEqual({ b: [SURROGATE_TEXT] });
  });

  it('#3 同じ項目に NUL と片割れの両方があれば 2 つの文言を NUL が先の順で返す', () => {
    expect(unusableTextDetailsOf({ b: 'y\u0000\ud800' })).toEqual({
      b: [NUL_TEXT, SURROGATE_TEXT],
    });
  });

  it('#3 片割れが NUL より前に現れても、文言の順は NUL が先', () => {
    expect(unusableTextDetailsOf({ b: '\ud800y\u0000' })).toEqual({
      b: [NUL_TEXT, SURROGATE_TEXT],
    });
  });

  it('#3 入れ子の配列に NUL が 2 つあっても、最上位の項目に文言は 1 つ（重複しない）', () => {
    expect(unusableTextDetailsOf({ p: { q: ['ok', 'n\u0000', 'm\u0000'] } })).toEqual({
      p: [NUL_TEXT],
    });
  });

  it('#3 入れ子のオブジェクトのキーに片割れがあれば、最上位の項目名で返す', () => {
    expect(unusableTextDetailsOf({ p: { 'k\ud800': 1 } })).toEqual({ p: [SURROGATE_TEXT] });
  });

  it('#3 入れ子のオブジェクトのキーに NUL があれば、最上位の項目名で返す', () => {
    expect(unusableTextDetailsOf({ p: { deep: { 'k\u0000': 'v' } } })).toEqual({
      p: [NUL_TEXT],
    });
  });

  it('#3 配列の中のオブジェクトの値（media[0].alt の形）も最上位の項目名で返す', () => {
    expect(
      unusableTextDetailsOf({ media: [{ url: 'https://x.example.com/a.png', alt: 'a\u0000' }] }),
    ).toEqual({ media: [NUL_TEXT] });
  });

  it('#3 最上位のキー自体に NUL があれば _', () => {
    expect(unusableTextDetailsOf({ 'k\u0000': 1 })).toEqual({ _: [NUL_TEXT] });
  });

  it('#3 最上位のキー自体に片割れがあれば _', () => {
    expect(unusableTextDetailsOf({ 'k\ud800': 1 })).toEqual({ _: [SURROGATE_TEXT] });
  });

  it('#3 本文が配列なら _', () => {
    expect(unusableTextDetailsOf(['a\u0000'])).toEqual({ _: [NUL_TEXT] });
  });

  it('#3 本文が文字列なら _', () => {
    expect(unusableTextDetailsOf('a\u0000')).toEqual({ _: [NUL_TEXT] });
  });

  it('#3 本文が片割れを含む文字列なら _ にサロゲートの文言', () => {
    expect(unusableTextDetailsOf('a\ud800')).toEqual({ _: [SURROGATE_TEXT] });
  });

  it('#3 複数の項目はすべてキーになり、キーの順は項目の順（a → b）', () => {
    const details = unusableTextDetailsOf({ a: 'x\u0000', b: 'y\ud800' });

    expect(details).toEqual({ a: [NUL_TEXT], b: [SURROGATE_TEXT] });
    expect(Object.keys(details)).toEqual(['a', 'b']);
  });

  it('#3 複数の項目のキーの順は本文の順（b が先なら b → a）', () => {
    const details = unusableTextDetailsOf({ b: 'y\ud800', a: 'x\u0000' });

    expect(Object.keys(details)).toEqual(['b', 'a']);
  });

  it('#3 何も無ければ空のオブジェクト', () => {
    expect(unusableTextDetailsOf({ a: 'x', b: ['y', { c: 'z' }], n: 1, t: true, u: null })).toEqual(
      {},
    );
  });

  it('#3 絵文字（対になったサロゲート）は使えない文字ではない', () => {
    expect(unusableTextDetailsOf({ body: `いいね${EMOJI}`, [`k${EMOJI}`]: EMOJI })).toEqual({});
  });

  it('#3 文字列でない最上位の値（数・真偽値・null・undefined）は何も返さない', () => {
    expect(unusableTextDetailsOf(1)).toEqual({});
    expect(unusableTextDetailsOf(null)).toEqual({});
    expect(unusableTextDetailsOf(undefined)).toEqual({});
    expect(unusableTextDetailsOf(true)).toEqual({});
  });

  it('#3 Date の中は見ない', () => {
    expect(unusableTextDetailsOf({ at: new Date(0) })).toEqual({});
  });

  it('#3 Uint8Array の中（0 のバイト）は見ない', () => {
    expect(unusableTextDetailsOf({ bytes: new Uint8Array([0, 0xd8, 0x00]) })).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* #4 toStorableText                                                            */
/* -------------------------------------------------------------------------- */

describe('#4 toStorableText は NUL と片割れを U+FFFD に置き換え、長さを変えない', () => {
  it('#4 NUL が U+FFFD になる', () => {
    expect(toStorableText('r\u0000')).toBe(`r${REPLACEMENT}`);
  });

  it('#4 片割れが U+FFFD になる', () => {
    expect(toStorableText('r\ud800')).toBe(`r${REPLACEMENT}`);
  });

  it('#4 NUL・上位の片割れ・下位の片割れが混ざっていても、それぞれ 1 文字ずつ U+FFFD になる', () => {
    expect(toStorableText('a\u0000\ud800b\udc00')).toBe(
      `a${REPLACEMENT}${REPLACEMENT}b${REPLACEMENT}`,
    );
  });

  it.each([
    ['NUL', 'r\u0000'],
    ['片割れ', 'r\ud800'],
    ['逆順の片割れ', '\ude00\ud83d'],
    ['NUL と片割れ', 'x\u0000y\ud800z'],
  ])('#4 %s を置き換えても length が変わらない', (_label, value) => {
    const replaced = toStorableText(value);

    expect(replaced.length).toBe(value.length);
    expect(containsNul(replaced)).toBe(false);
    expect(containsLoneSurrogate(replaced)).toBe(false);
  });

  it('#4 絵文字（対になったサロゲート）は変わらない', () => {
    const value = `配信しました${EMOJI}${EMOJI}`;

    expect(toStorableText(value)).toBe(value);
  });

  it('#4 通常の文は変わらない', () => {
    expect(toStorableText('結果不明：タイムアウト')).toBe('結果不明：タイムアウト');
  });

  it('#4 空文字は空文字のまま', () => {
    expect(toStorableText('')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* #5 文言                                                                      */
/* -------------------------------------------------------------------------- */

describe('#5 文言の定数', () => {
  it('#5 NUL_MESSAGE が設計の文言と等しい', () => {
    expect(NUL_MESSAGE).toBe(NUL_TEXT);
  });

  it('#5 LONE_SURROGATE_MESSAGE が設計の文言と等しい', () => {
    expect(LONE_SURROGATE_MESSAGE).toBe(SURROGATE_TEXT);
  });

  it('#5 unusableTextDetailsOf の文言は定数と同じ値', () => {
    expect(unusableTextDetailsOf({ a: '\u0000\ud800' })).toEqual({
      a: [NUL_MESSAGE, LONE_SURROGATE_MESSAGE],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 検証の指摘（2026-09-25）M1・M2                                                */
/* -------------------------------------------------------------------------- */

/**
 * M1：`Object.prototype` の名前（`__proto__`・`constructor`・`toString`・`valueOf`・`hasOwnProperty`）の項目でも、
 * 例外を投げずにその名前をキーにして返す（046 実装プラン §8「検証の指摘への処置」）。
 *
 * `JSON.parse` は `"__proto__"` を**自分のプロパティ**として作る。オブジェクトのリテラルの `__proto__:` は
 * 原型を変えてしまうので、入力は JSON の文字列から作る。返り値は `Object.entries` で見る（原型の名前と区別するため）。
 */
const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

const PROTOTYPE_NAME_CASES = PROTOTYPE_NAMES.flatMap((name) => [
  { name, label: 'NUL', escaped: '\\u0000', text: NUL_TEXT },
  { name, label: '片割れ', escaped: '\\ud800', text: SURROGATE_TEXT },
]);

describe('M1 unusableTextDetailsOf は原型の名前の項目でも例外を投げない', () => {
  it.each(PROTOTYPE_NAME_CASES)(
    'M1 最上位の項目 $name に $label → その名前をキーにして返す',
    ({ name, escaped, text }) => {
      const value = JSON.parse(`{"ok":"x","${name}":"v${escaped}"}`) as unknown;

      expect(Object.entries(unusableTextDetailsOf(value))).toEqual([[name, [text]]]);
    },
  );

  it.each(PROTOTYPE_NAME_CASES)(
    'M1 入れ子の項目 $name に $label → 最上位の項目名で返す',
    ({ name, escaped, text }) => {
      const value = JSON.parse(`{"p":{"${name}":"v${escaped}"}}`) as unknown;

      expect(Object.entries(unusableTextDetailsOf(value))).toEqual([['p', [text]]]);
    },
  );

  it.each(PROTOTYPE_NAMES)('M1 使えない文字の無い項目 %s → 空', (name) => {
    const value = JSON.parse(`{"${name}":"v"}`) as unknown;

    expect(Object.entries(unusableTextDetailsOf(value))).toEqual([]);
  });

  it('M1 返り値は通常のオブジェクトで、__proto__ は自分のプロパティ（原型を変えない）', () => {
    const details = unusableTextDetailsOf(JSON.parse('{"__proto__":"v\\u0000"}') as unknown);

    expect(Object.getPrototypeOf(details)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(details, '__proto__')?.value).toEqual([NUL_TEXT]);
    expect(JSON.stringify(details)).toBe(JSON.stringify({ ['__proto__']: [NUL_TEXT] }));
  });
});

/**
 * M2：入れ子の深さで例外（`RangeError`）にならない。`JSON.parse` は 10,000 段の入れ子を読めるので、
 * 認証の要らない口にも 10KB ほどで届く（046 実装プラン §8「検証の指摘への処置」）。
 * 入力は JSON の文字列から作る（`JSON.stringify` は深い入れ子を書けない）。
 */
const DEPTH = 10_000;

function nestedArrays(depth: number, leafJson: string): string {
  return `${'['.repeat(depth)}${leafJson}${']'.repeat(depth)}`;
}

function nestedObjects(depth: number, leafJson: string): string {
  return `${'{"a":'.repeat(depth)}${leafJson}${'}'.repeat(depth)}`;
}

describe('M2 unusableTextDetailsOf は深い入れ子でも例外を投げない', () => {
  it('M2 10,000 段の配列の底に NUL → 最上位の項目名で NUL の文言', () => {
    const value = JSON.parse(`{"p":${nestedArrays(DEPTH, '"v\\u0000"')}}`) as unknown;

    expect(unusableTextDetailsOf(value)).toEqual({ p: [NUL_TEXT] });
  });

  it('M2 10,000 段のオブジェクトの底に片割れ → 最上位の項目名でサロゲートの文言', () => {
    const value = JSON.parse(`{"p":${nestedObjects(DEPTH, '"v\\ud800"')}}`) as unknown;

    expect(unusableTextDetailsOf(value)).toEqual({ p: [SURROGATE_TEXT] });
  });

  it('M2 10,000 段のオブジェクトの底のキーに NUL → 最上位の項目名で返す', () => {
    const value = JSON.parse(`{"p":${nestedObjects(DEPTH, '{"k\\u0000":1}')}}`) as unknown;

    expect(unusableTextDetailsOf(value)).toEqual({ p: [NUL_TEXT] });
  });

  it('M2 深さの違う場所に片割れと NUL → 文言は NUL が先の 2 つ', () => {
    const value = JSON.parse(`{"p":["\\ud800",${nestedArrays(DEPTH, '"v\\u0000"')}]}`) as unknown;

    expect(unusableTextDetailsOf(value)).toEqual({ p: [NUL_TEXT, SURROGATE_TEXT] });
  });

  it('M2 最上位が 10,000 段の配列で底に NUL → `_`', () => {
    const value = JSON.parse(nestedArrays(DEPTH, '"v\\u0000"')) as unknown;

    expect(unusableTextDetailsOf(value)).toEqual({ _: [NUL_TEXT] });
  });

  it('M2 使えない文字の無い 10,000 段の入れ子 → 空', () => {
    const value = JSON.parse(
      `{"p":${nestedArrays(DEPTH, '"v"')},"q":${nestedObjects(DEPTH, '"w"')}}`,
    ) as unknown;

    expect(unusableTextDetailsOf(value)).toEqual({});
  });

  it('M2 項目の順は深さに左右されない（本文の順）', () => {
    const value = JSON.parse(
      `{"a":${nestedArrays(DEPTH, '"v\\u0000"')},"b":"w\\u0000"}`,
    ) as unknown;

    expect(Object.keys(unusableTextDetailsOf(value))).toEqual(['a', 'b']);
  });
});
