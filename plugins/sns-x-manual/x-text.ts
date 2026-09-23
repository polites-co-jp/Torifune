/**
 * X の本文の組み立て・重み付きの数え方・Web Intent の URL（037-sns-x 設計 §9.4）。
 *
 * **このファイルは `sns-x-manual` と `sns-x-api` に同じ内容で置く。片方だけを直さない。**
 * 2 つの写しがバイト単位で同じであることはテストが固定している（設計 §4.2 / §10.2 の #9）。
 * 直すときは 2 ファイルを同じコミットで直す。
 *
 * **純関数だけを置く。** 外部 I/O・時計・乱数を持たない。
 * `@torifune/plugin-api` からは型だけを引く。
 */
import type { ManualHandoff, PublisherValidationProblem } from '@torifune/plugin-api';

/** X の本文の上限（重み付き）。 */
export const X_WEIGHTED_LENGTH_MAX = 280;

/** URL が数えられる長さ（t.co）。URL の実際の長さによらない。 */
export const X_URL_WEIGHT = 23;

/** Web Intent の宛先。**定数であり、設定から変えられない**（設計 §5.3）。 */
export const X_INTENT_BASE_URL = 'https://x.com/intent/tweet';

/**
 * 手動投稿の URL の上限。
 *
 * Core の `isValidManualUrl`（`isValidExternalUrl`）と同じ値。Plugin は Core の定数を import しないので値を持つ。
 * 一致はテストが見る（設計 §10.10 の #62）。
 */
export const MANUAL_URL_MAX_LENGTH = 2048;

/**
 * 手動投稿の注意書き（設計 §9.5）。
 *
 * **「画像は投稿画面で添付してください」と断定しない。** 手動投稿には画像を付けられない（Core が 422）ので、
 * 断定すると「付けたはずの画像が落ちた」と読まれる。
 */
export const X_MANUAL_NOTE =
  'X の投稿画面が開きます。内容を確かめて投稿してください。画像を添える場合はその画面で添付してください。';

/**
 * grapheme の区切り。
 *
 * **module スコープで 1 つだけ作る。** 生成が重く、`validate()` は 1 画面の描画で何度も呼ばれる。
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 本文中の URL らしき並び。空白までを 1 つとみなし、末尾は後で削る（036 の数え方と同じ規則）。 */
const URL_PATTERN = /https?:\/\/[^\s]+/g;

/** ホスト名まで揃っているか（末尾を削った結果 `https://` だけになったものは URL と数えない）。 */
const URL_WITH_HOST_PATTERN = /^https?:\/\/[^\s/?#]+/;

/** 絵文字として 2 と数える grapheme（ZWJ で繋いだ並びや国旗も 1 つで 2）。 */
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * URL の末尾から外す文字。
 *
 * 句読点・閉じ括弧は文の一部であって URL の一部ではない（036 の数え方と同じ集合）。
 */
const TRAILING_CHARS = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '」',
  '）',
  '。',
  '、',
  '！',
  '？',
  '：',
  '；',
]);

/**
 * 重み 1 で数えるコードポイントの範囲（両端を含む）。それ以外は 2。
 *
 * 公式の数え方（twitter-text の設定 v3）の重みの範囲。CJK は 2 になる。
 */
const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if (char === undefined || !TRAILING_CHARS.has(char)) {
      break;
    }
    end -= 1;
  }
  return url.slice(0, end);
}

function isLight(codePoint: number): boolean {
  return LIGHT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** URL を含まない文字列の重み。 */
function weightOfPlainText(text: string): number {
  if (text === '') {
    return 0;
  }
  let weight = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (EMOJI_PATTERN.test(segment)) {
      weight += 2;
      continue;
    }
    for (const char of segment) {
      weight += isLight(char.codePointAt(0) ?? 0) ? 1 : 2;
    }
  }
  return weight;
}

/**
 * X の数え方による重み付きの長さ（設計 §9.4 の 1〜4）。
 *
 * 1. NFC に正規化する
 * 2. `https?://` から空白までを URL とし（末尾の句読点・閉じ括弧を外す）、1 つにつき 23 と数えて取り除く
 * 3. 残りを grapheme に分け、絵文字なら 2、それ以外はコードポイントごとに 1 か 2
 *
 * **`https://` の無いドメインを 23 と数えない**（公式の数え方とは食い違う。設計 §11 #3）。
 * URL の前後は別々に数える（取り除いた後で繋ぐと、前後の文字が 1 つの grapheme に化けうる）。
 */
export function countXWeightedLength(text: string): number {
  const normalized = typeof text === 'string' ? text.normalize('NFC') : '';

  let weight = 0;
  let cursor = 0;
  for (const match of normalized.matchAll(URL_PATTERN)) {
    const index = match.index;
    const url = trimTrailing(match[0]);
    if (!URL_WITH_HOST_PATTERN.test(url)) {
      continue;
    }
    weight += weightOfPlainText(normalized.slice(cursor, index)) + X_URL_WEIGHT;
    cursor = index + url.length;
  }

  return weight + weightOfPlainText(normalized.slice(cursor));
}

/**
 * 実際に X へ渡す本文。`link` が空でない文字列なら改行して末尾に足す（設計 §9.4）。
 *
 * 自動投稿の `text` にも、手動投稿の intent URL の `text` にもこの文字列が入る（2 つを一致させる）。
 * 外から来た任意の値を受けるので、**文字列でなければ空として扱い、例外を投げない。**
 */
export function composeXText(post: { readonly body: unknown; readonly link: unknown }): string {
  const body = typeof post.body === 'string' ? post.body : '';
  const link = post.link;
  if (typeof link === 'string' && link !== '') {
    return `${body}\n${link}`;
  }
  return body;
}

/**
 * 手動投稿の URL（設計 §9.4）。
 *
 * **`url=` の引数を使わず、`link` も `text` に入れる。** 本文と URL の繋ぎ方を X に決めさせると、
 * Torifune が数えた文字列と投稿画面に入る文字列が一致しなくなる。
 */
export function buildXIntentUrl(post: { readonly body: unknown; readonly link: unknown }): string {
  return `${X_INTENT_BASE_URL}?text=${encodeURIComponent(composeXText(post))}`;
}

/**
 * `validate()` のうち本文に関する検査（設計 §9.2 の 2 と 3）。
 *
 * **2 つの Plugin の `validate()` が本文について言うことは、すべてここから来る**（設計 §4.2）。
 * 同期で返す。例外を投げない。問題が無ければ空配列。
 */
export function checkXText(post: {
  readonly body: unknown;
  readonly link: unknown;
  readonly deliveryMode: unknown;
}): PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  // 2：自動・手動とも同じ文字列（composeXText）を数える。
  const weight = countXWeightedLength(composeXText(post));
  if (weight > X_WEIGHTED_LENGTH_MAX) {
    problems.push({
      field: 'body',
      message:
        `X の本文は${X_WEIGHTED_LENGTH_MAX}（半角換算）以内にしてください` +
        `（日本語・絵文字は1文字を2、URLは長さによらず${X_URL_WEIGHT}と数えます。` +
        `link を指定した場合はそれも含みます）。いまは ${weight} です。`,
    });
  }

  // 3：手動投稿だけ。URL は 23 と数えられても、エンコードした intent URL では全長が効く。
  // 登録時に断らないと、予約時刻に手動投稿待ちへ並んでから初めて開けないと分かる。
  if (post.deliveryMode === 'manual' && buildXIntentUrl(post).length > MANUAL_URL_MAX_LENGTH) {
    problems.push({
      field: 'body',
      message: '投稿画面の URL が長くなりすぎます。本文中の URL を短くしてください。',
    });
  }

  return problems;
}

/** `manual()` の中身（設計 §9.5）。2 つの Plugin の `manual()` は同じ入力に同じ値を返す。 */
export function buildXManualHandoff(post: {
  readonly body: unknown;
  readonly link: unknown;
}): ManualHandoff {
  return { url: buildXIntentUrl(post), note: X_MANUAL_NOTE };
}
