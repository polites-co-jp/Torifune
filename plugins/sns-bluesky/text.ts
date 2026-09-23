/**
 * 本文の数え方と facets の組み立て（036-sns-bluesky 設計 §6.7 / §9.3）。
 *
 * **純関数だけを置く。** 外部 I/O を持たず、Key-Value Store にも触れない。
 * 数え方と facet の検査に HTTP の差し替えが要らなくなる（設計 §4）。
 *
 * 使ってよいのは Node の標準（`Intl.Segmenter` / `TextEncoder`）だけで、
 * `@torifune/plugin-api` からは値を取らない。
 */

/**
 * grapheme の区切り。
 *
 * **module スコープで1つだけ作る。** `Intl.Segmenter` は生成が重く、
 * `validate()` は1画面の描画で何度も呼ばれる（設計 §9.3）。
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const utf8Encoder = new TextEncoder();

/**
 * 見た目の1文字（grapheme cluster）の数。
 *
 * **`String.length`（UTF-16 の要素数）では数えない。** 絵文字の結合や
 * サロゲートペア・肌色修飾・異体字セレクタで実際の文字数と食い違う。
 */
export function graphemeCount(text: string): number {
  if (text === '') {
    return 0;
  }
  const iterator = graphemeSegmenter.segment(text)[Symbol.iterator]();
  let count = 0;
  while (iterator.next().done !== true) {
    count += 1;
  }
  return count;
}

/** UTF-8 に符号化したときのバイト数。 */
export function utf8ByteLength(text: string): number {
  if (text === '') {
    return 0;
  }
  return utf8Encoder.encode(text).length;
}

/** facet の位置。**UTF-8 のバイト単位**（設計 §6.7）。 */
export interface FacetByteRange {
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface LinkFacetFeature {
  readonly $type: 'app.bsky.richtext.facet#link';
  readonly uri: string;
}

export interface LinkFacet {
  readonly index: FacetByteRange;
  readonly features: readonly LinkFacetFeature[];
}

/** 本文中の URL らしき並び。空白までを1つとみなし、末尾は後で削る。 */
const URL_PATTERN = /https?:\/\/[^\s]+/g;

/**
 * URL の末尾から外す文字。
 *
 * 句読点・閉じ括弧は文の一部であって URL の一部ではない（設計 §6.7）。
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

/** ホスト名まで揃っているか（末尾を削った結果 `https://` だけになったものを捨てる）。 */
const URL_WITH_HOST_PATTERN = /^https?:\/\/[^\s/?#]+/;

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
 * 本文中の URL から facets を組み立てる（設計 §6.7）。
 *
 * **Bluesky は本文の URL を自動ではリンクにしない。** facets を付けない投稿の
 * URL は、ただの文字列として表示される。
 *
 * 見つからなければ空配列を返す（`record` へ入れるかどうかは呼び出し側が決める）。
 */
export function detectLinkFacets(text: string): readonly LinkFacet[] {
  const facets: LinkFacet[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const index = match.index;
    if (index === undefined) {
      continue;
    }

    const uri = trimTrailing(raw);
    if (!URL_WITH_HOST_PATTERN.test(uri)) {
      continue;
    }

    // **UTF-16 の添字をそのまま渡さない。** 日本語や絵文字を含む本文で
    // リンクの位置がずれる（設計 §6.7）。
    const byteStart = utf8ByteLength(text.slice(0, index));
    facets.push({
      index: { byteStart, byteEnd: byteStart + utf8ByteLength(uri) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }

  return facets;
}
