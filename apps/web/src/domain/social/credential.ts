/**
 * SNS アカウントの資格情報の形式（035-social-publishing 設計 §5.6.3）。
 *
 * **Domain 層。** 暗号方式も DB も Plugin API も知らない。
 * ここが扱うのは「平文が publisher の宣言した形に合っているか」だけ。
 * 保存形式（暗号化した 1 つの文字列）は変えていない（§5.7）。
 */

/**
 * publisher が宣言する資格情報の項目。
 *
 * Core 側の最小の型。`PluginSettingsField` から Application が写す
 * （Domain は `@torifune/plugin-api` を知らない）。
 * `kind` の違いは**入力欄の見え方だけ**で、保存は丸ごと 1 つの暗号文（§5.7）。
 */
export interface CredentialField {
  readonly key: string;
  readonly kind: 'text' | 'secret';
}

/** JSON にした後の長さの上限。既存の `credential` の上限と同じ。 */
export const CREDENTIAL_MAX_LENGTH = 4096;

/**
 * 平文が JSON オブジェクト（値はすべて文字列）なら取り出す。
 *
 * 自由文字列・配列・入れ子は `null`。自由文字列で登録済みのアカウントに
 * 後から Plugin を入れた場合がこれに当たる（§5.7）。
 */
export function parseCredentialObject(plaintext: string): Readonly<Record<string, string>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      return null;
    }
    values[key] = value;
  }
  return values;
}

/**
 * 宣言された項目と突き合わせる。
 *
 * 不足と未知のキーを問題として返す。**宣言が空なら常に `[]`**
 * （資格情報の要らない配信手段では突き合わせない。§5.7）。
 * `field` は 422 の `details` のキー（`credentials`。§6.4）。
 */
export function validateCredentialAgainstFields(
  values: Readonly<Record<string, string>>,
  fields: readonly CredentialField[],
): readonly { readonly field: string; readonly message: string }[] {
  if (fields.length === 0) {
    return [];
  }

  const problems: { readonly field: string; readonly message: string }[] = [];
  const declared = new Set(fields.map((field) => field.key));

  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === '') {
      problems.push({ field: 'credentials', message: `${field.key} を指定してください。` });
    }
  }
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      // 打ち間違いを黙って保存しない。
      problems.push({
        field: 'credentials',
        message: `${key} は指定できません（定義に無い項目）。`,
      });
    }
  }

  return problems;
}
