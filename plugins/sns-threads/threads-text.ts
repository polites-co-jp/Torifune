/**
 * Threads の本文の組み立て・数え方・URL の数え方・Web Intent の URL（040-sns-threads 設計 §9.3〜§9.5）。
 *
 * **純関数だけを置く。** 外部 I/O・時計・乱数を持たない。
 * `@torifune/plugin-api` からは型だけを引く。
 *
 * X の Plugin の本文の数え方と形は似ているが、共有しない（別の SNS で、振る舞いを揃える理由が無い。設計 §4.2）。
 */
import type { ManualHandoff, PublisherValidationProblem } from '@torifune/plugin-api';

/** Threads の本文の上限（§9.4 の数え方で）。 */
export const THREADS_TEXT_MAX = 500;

/** 1 投稿に含められる異なる URL の数。 */
export const THREADS_LINK_MAX = 5;

/** Web Intent の宛先。**定数であり、設定から変えられない**（設計 §5.3 / §9.5）。 */
export const THREADS_INTENT_BASE_URL = 'https://www.threads.com/intent/post';

/**
 * 手動投稿の URL の上限。
 *
 * Core の `isValidManualUrl`（`isValidExternalUrl`）と同じ値。Plugin は Core の定数を import しないので値を持つ。
 * 一致はテストが見る（設計 §10.11 の #82）。
 */
export const MANUAL_URL_MAX_LENGTH = 2048;

/**
 * 手動投稿の注意書き（設計 §9.5）。
 *
 * **「画像は投稿画面で添付してください」と断定しない。** 手動投稿には画像を付けられない（Core が 422）ので、
 * 断定すると「付けたはずの画像が落ちた」と読まれる。
 */
export const THREADS_MANUAL_NOTE =
  'Threads の投稿画面が開きます。内容を確かめて投稿してください。画像を添える場合はその画面で添付してください。';

/**
 * grapheme の区切り。
 *
 * **module スコープで 1 つだけ作る。** 生成が重く、`validate()` は 1 画面の描画で何度も呼ばれる。
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** UTF-8 のバイト数を数える。module スコープで 1 つだけ。 */
const utf8Encoder = new TextEncoder();

/**
 * 「絵文字の grapheme」とみなすコードポイント（設計 §9.4）。1 つでも含めば grapheme 全体を UTF-8 のバイト数で数える。
 *
 * * `Extended_Pictographic`（絵文字の本体。`©` `®` `™` などの記号も含む）
 * * `Regional_Indicator`（国旗の組）
 * * `Emoji_Modifier`（肌の色）
 * * U+FE0F（絵文字の表示を求める異体字セレクタ）、U+20E3（キーキャップ）
 * * U+E0020〜U+E007F（タグ文字。地域の旗）
 *
 * **広く取るほど多く数える**（同じ grapheme では UTF-8 のバイト数 ≥ UTF-16 の長さ）。
 */
const EMOJI_CODE_POINT_PATTERN =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3\u{E0020}-\u{E007F}]/u;

/**
 * 本文中の URL らしき並び。**ASCII の表示文字（`\x21`〜`\x7E`）が続く限り**を 1 つとみなし、末尾は後で削る（設計 §9.4）。
 *
 * **空白だけでなく、非 ASCII の文字でも終わる。** 日本語の文では URL の直後に空白を置かないことが多い（037 中-1）。
 * スキームの大文字・小文字を問わない。
 */
const URL_PATTERN = /https?:\/\/[\x21-\x7E]*/gi;

/** URL の先頭のスキーム。これを外して何も残らないものは URL と数えない。 */
const URL_SCHEME_PATTERN = /^https?:\/\//i;

/**
 * URL の末尾から外す文字。
 *
 * 句読点・閉じ括弧は文の一部であって URL の一部ではない。
 * 全角の句読点・括弧は非 ASCII なので、もともと `URL_PATTERN` の並びに入らない。
 */
const TRAILING_CHARS = new Set(['.', ',', ';', ':', '!', '?', ')', ']']);

/**
 * 対になっていないサロゲート（片割れ）。
 *
 * **`u` フラグを付けない**（付けると正しい対が 1 文字として扱われ、片割れとの区別に使えない）。
 * `String.prototype.isWellFormed` / `toWellFormed` は `tsconfig` の `lib` に型が無いので正規表現で書く（設計 §9.5）。
 */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 置き換え用（`g` を付けたもの）。判定には `g` の無いほうを使う（`lastIndex` を持ち越さない）。 */
const LONE_SURROGATE_GLOBAL_PATTERN = new RegExp(LONE_SURROGATE_PATTERN.source, 'g');

/** 片割れを見つけたときの文言（設計 §9.2 の 1）。 */
const LONE_SURROGATE_MESSAGE = '本文に扱えない文字が含まれています。';

/** intent URL が長すぎるときの文言（設計 §9.2 の 4）。 */
const INTENT_URL_TOO_LONG_MESSAGE = '投稿画面の URL が長くなりすぎます。本文を短くしてください。';

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

/**
 * 実際に Threads へ渡す本文。`link` が空でない文字列なら改行して末尾に足す（設計 §9.3 / §6.12）。
 *
 * 自動配信の `text` にも、手動投稿の intent URL の `text` にもこの文字列が入る（2 つを一致させる）。
 * 外から来た任意の値を受けるので、**文字列でなければ空として扱い、例外を投げない。**
 */
export function composeThreadsText(post: {
  readonly body: unknown;
  readonly link: unknown;
}): string {
  const body = typeof post.body === 'string' ? post.body : '';
  const link = post.link;
  if (typeof link === 'string' && link !== '') {
    return `${body}\n${link}`;
  }
  return body;
}

/**
 * §9.4 の数え方による長さ。**公開されていない部分は多めに数える側に倒す。**
 *
 * 1. 正規化しない（NFC にも NFD にもしない）
 * 2. grapheme に分ける
 * 3. 絵文字の grapheme なら grapheme 全体の UTF-8 のバイト数、それ以外は UTF-16 の長さ（`String.length`）
 * 4. 合計
 *
 * どの grapheme でも UTF-8 のバイト数 ≥ UTF-16 の長さなので、結果は `String.length` を下回らない。
 * 対になっていないサロゲートを含む本文は、先に `checkThreadsText` が断る（ここでは数えない前提）。
 */
export function countThreadsLength(text: string): number {
  if (typeof text !== 'string' || text === '') {
    return 0;
  }
  let length = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    length += EMOJI_CODE_POINT_PATTERN.test(segment)
      ? utf8Encoder.encode(segment).length
      : segment.length;
  }
  return length;
}

/**
 * 本文の中の異なる URL の数（設計 §9.4 の「URL の数え方」）。
 *
 * * `https?://` から ASCII の表示文字が続く限りを URL とし、末尾の `.,;:!?)]` を外す
 * * スキームだけが残ったものは数えない
 * * **同じかどうかは文字列の完全一致**（大文字・小文字・末尾の `/` の違いは別の URL＝多めの側）
 * * `https://` の無いドメインは数えない（設計 §11 #2 の (b)）
 */
export function countThreadsLinks(text: string): number {
  if (typeof text !== 'string' || text === '') {
    return 0;
  }
  const found = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0]);
    if (url.replace(URL_SCHEME_PATTERN, '') === '') {
      continue;
    }
    found.add(url);
  }
  return found.size;
}

/** 対になっていないサロゲートを含むか。 */
export function hasLoneSurrogate(text: string): boolean {
  return typeof text === 'string' && LONE_SURROGATE_PATTERN.test(text);
}

/**
 * 手動投稿の URL（設計 §9.5）。
 *
 * **`url=` の引数を使わず、`link` も `text` に入れる。** 本文と URL の繋ぎ方を Threads に決めさせると、
 * Torifune が数えた文字列と投稿画面に入る文字列が一致しなくなる。
 *
 * **対になっていないサロゲートは U+FFFD に置き換えてからエンコードする**（`encodeURIComponent` は片割れで
 * `URIError` を投げる）。`manual()` は `validate()` を通っていない投稿でも呼ばれうるので、ここでも投げない。
 * 正しい文字列には何もしない。
 */
export function buildThreadsIntentUrl(post: {
  readonly body: unknown;
  readonly link: unknown;
}): string {
  const text = composeThreadsText(post).replace(LONE_SURROGATE_GLOBAL_PATTERN, '\uFFFD');
  return `${THREADS_INTENT_BASE_URL}?text=${encodeURIComponent(text)}`;
}

/**
 * `validate()` のうち本文に関する検査（設計 §9.2 の 1〜4）。
 *
 * **`validate()` が本文について言うことは、すべてここから来る。**
 * 1〜4 は自動・手動とも同じ文字列（`composeThreadsText`）を見る。4 は手動投稿だけ。
 * 同期で返す。例外を投げない。問題が無ければ空配列。複数の違反はすべて返す。
 */
export function checkThreadsText(post: {
  readonly body: unknown;
  readonly link: unknown;
  readonly deliveryMode: unknown;
}): PublisherValidationProblem[] {
  const text = composeThreadsText(post);

  // 1：片割れがあれば、2〜4 を数えない（UTF-8 のバイト数が U+FFFD の 3 バイトに化けて数えを誤る）。
  if (hasLoneSurrogate(text)) {
    return [{ field: 'body', message: LONE_SURROGATE_MESSAGE }];
  }

  const problems: PublisherValidationProblem[] = [];

  // 2：本文の長さ（§9.4 の数え方）。
  const length = countThreadsLength(text);
  if (length > THREADS_TEXT_MAX) {
    problems.push({
      field: 'body',
      message:
        `Threads の本文は${THREADS_TEXT_MAX}文字以内にしてください` +
        '（絵文字は1つを UTF-8 のバイト数で数えるため、多くは4文字以上になります。' +
        `link を指定した場合はそれも含みます）。いまは ${length} です。`,
    });
  }

  // 3：異なる URL の数。
  const links = countThreadsLinks(text);
  if (links > THREADS_LINK_MAX) {
    problems.push({
      field: 'body',
      message:
        `Threads の投稿に含められるリンクは${THREADS_LINK_MAX}本までです` +
        `（本文の URL と link を合わせて数えます）。いまは ${links} 本です。`,
    });
  }

  // 4：手動投稿だけ。Core は manual() の URL を 2048 文字で断るので、登録時に断る（設計 §9.2 の 4）。
  if (
    post.deliveryMode === 'manual' &&
    buildThreadsIntentUrl(post).length > MANUAL_URL_MAX_LENGTH
  ) {
    problems.push({ field: 'body', message: INTENT_URL_TOO_LONG_MESSAGE });
  }

  return problems;
}

/** `manual()` の中身（設計 §9.5）。 */
export function buildThreadsManualHandoff(post: {
  readonly body: unknown;
  readonly link: unknown;
}): ManualHandoff {
  return { url: buildThreadsIntentUrl(post), note: THREADS_MANUAL_NOTE };
}
