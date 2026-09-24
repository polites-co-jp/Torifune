import { ValidationError } from '@/domain/repository';
import { unusableTextDetailsOf } from '@/domain/text';

/**
 * UseCase の入力の保存できない文字（NUL・対になっていないサロゲート）を断る（L2。046-input-500-nul-and-ranges 設計 §4.1・§4.2）。
 *
 * HTTP の要求は `api/route.ts`（L1）が先に断るので、ここは Data API・画面の Server Component・Core の内部から
 * 直接呼ばれる経路の守り。**保存・検索に使う文字列の項目だけ**を渡す（ID の項目は形の検査が「存在しない」として扱う）。
 *
 * `undefined`・`null` の項目は見ない（省略・未指定はそのまま）。値は返さず、`ValidationError` の
 * `message` にも `details` にも送った値を載せない。
 */
export function assertUsableText(
  resource: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  const present: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      present[field] = value;
    }
  }

  const details = unusableTextDetailsOf(present);
  const first = Object.entries(details)[0];
  if (first === undefined) {
    return;
  }
  const [field, messages] = first;
  throw new ValidationError(resource, field, messages[0] ?? '', details);
}
