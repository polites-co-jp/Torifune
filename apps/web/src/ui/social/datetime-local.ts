/**
 * `datetime-local` の値と ISO 文字列の変換（投稿フォームと承認のダイアログで共有する。
 * 048-social-post-approval 設計 §7.1.3）。**閲覧者の時刻で**読み書きする。
 */

/** `datetime-local` の値（閲覧者の時刻）を ISO 文字列へ。空・読めない値は null。 */
export function toIsoOrNull(local: string): string | null {
  if (local === '') {
    return null;
  }
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO 文字列を `datetime-local` が読む形（`YYYY-MM-DDTHH:mm`）へ、閲覧者の時刻で直す。 */
export function toLocalInputValue(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
