import { type z } from 'zod';

/**
 * Zod による入力検証（05_API設計.md §11）。
 *
 * **検証を通ったら型が保証されている**状態にする。
 * `as` で通すと、検証の意味が無くなる。
 */

export type ValidationDetails = Record<string, readonly string[]>;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly details: ValidationDetails };

/** Zod のエラーを、フィールド単位の説明へ落とす。 */
export function toValidationDetails(error: z.ZodError): ValidationDetails {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    // ルート（パスが空）のエラーは `_` にまとめる。
    const key = issue.path.length === 0 ? '_' : issue.path.map(String).join('.');
    (details[key] ??= []).push(issue.message);
  }

  return details;
}

/**
 * スキーマを適用する。
 *
 * 未知のフィールドは Zod の既定どおり無視する。拒否すると、
 * クライアントが将来のフィールドを送ったときに壊れ、前方互換性が失われる。
 */
export function validate<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): ValidationResult<z.output<TSchema>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, details: toValidationDetails(parsed.error) };
}

/** リクエストボディを JSON として読む。壊れていても例外を投げない。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
