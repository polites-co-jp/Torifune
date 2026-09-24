/**
 * ID の形の判定。
 *
 * **このファイルは Domain 層にある。DB 製品にも Zod にも依存しない。**
 */

/**
 * UUID の形（8-4-4-4-12 の 16 進）。大文字・小文字を問わず、版と variant を見ない。
 *
 * HTTP の入口の `z.guid()` と、各 Repository の `UUID_PATTERN` と同じ判定にする。
 * 判定が食い違うと、同じ値が経路によって「形の誤り」になったり「存在しない」になったりする。
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 文字列で、UUID の形であるときだけ `true`。空文字・数値・オブジェクトは `false`。 */
export function isUuidShape(value: unknown): boolean {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}
