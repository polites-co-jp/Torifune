/**
 * キャプションの数え方（038-sns-instagram 設計 §9.2）。
 *
 * **純関数だけ。** HTTP も時計も持たない。
 *
 * **多めに数える側に倒す。** Instagram の数え方より多く数えれば、
 * 登録時に断られることはあっても、配信時に初めて断られることは無い。
 */

/**
 * ハッシュタグ：`#` か全角の `＃` の直後に、文字・数字・`_` が 1 つ以上。
 * 直前が文字・数字・`_`・`&` のときは数えない（`a#b` や `&#123;` を拾わない）。
 */
const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_&])[#＃][\p{L}\p{N}_]+/gu;

/**
 * メンション：`@` の直後に英数字・`.`・`_` が 1 つ以上。直前の条件はハッシュタグと同じ
 * （メールアドレス `a@b.com` を拾わない）。
 */
const MENTION_PATTERN = /(?<![\p{L}\p{N}_&])@[A-Za-z0-9._]+/gu;

/** ハッシュタグの数。 */
export function countHashtags(text: string): number {
  // `String.prototype.match` は `g` の正規表現の lastIndex を毎回 0 から始める。
  return text.match(HASHTAG_PATTERN)?.length ?? 0;
}

/** メンション（`@ユーザーネーム`）の数。 */
export function countMentions(text: string): number {
  return text.match(MENTION_PATTERN)?.length ?? 0;
}
