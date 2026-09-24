/**
 * 保存できない文字の規則（046-input-500-nul-and-ranges 設計 §4.1・§6.2）。
 *
 * * **NUL（U+0000）** は PostgreSQL の `text` にも `jsonb` にも保存できない
 * * **対になっていないサロゲート（片割れ）** は `text` では黙って U+FFFD に置き換わり、`jsonb` では断られる
 *
 * どちらも入力としては断る（HTTP は 422、UseCase・Data API は `ValidationError`、Plugin Store は `PluginStoreError`）。
 * Core が書く Plugin 由来・システム由来の文字列（L4）だけは断る相手がいないので、`toStorableText` で置き換えて記録する。
 *
 * **ここは純関数と定数だけ。** DB 製品・Zod に依存しない。
 */

export const NUL_MESSAGE = '使用できない文字（NUL）が含まれています。';

export const LONE_SURROGATE_MESSAGE =
  '使用できない文字（対になっていないサロゲート）が含まれています。';

/**
 * 対になっていないサロゲート。上位（U+D800〜U+DBFF）の後に下位が続かないもの、下位（U+DC00〜U+DFFF）の前に上位が無いもの。
 *
 * **`u` フラグを付けない**（付けると片割れに一致しなくなる）。`String.prototype.isWellFormed` は
 * ES2024 で `lib`（ES2023）に型が無いので使わない（`037` の先例）。量指定子の入れ子が無く、入力の長さに対して線形。
 */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_PATTERN_GLOBAL = new RegExp(LONE_SURROGATE_PATTERN.source, 'g');
const NUL_CHARACTER = String.fromCharCode(0);

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export function containsNul(value: string): boolean {
  return value.includes(NUL_CHARACTER);
}

export function containsLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE_PATTERN.test(value);
}

/** 1 つの文字列の誤りの文言（NUL が先）。 */
function messagesOf(value: string): string[] {
  const messages: string[] = [];
  if (containsNul(value)) {
    messages.push(NUL_MESSAGE);
  }
  if (containsLoneSurrogate(value)) {
    messages.push(LONE_SURROGATE_MESSAGE);
  }
  return messages;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** 値の中（入れ子の値とオブジェクトのキー）に NUL・片割れがあるかを集める。 */
function collect(value: unknown, found: { nul: boolean; surrogate: boolean }): void {
  if (found.nul && found.surrogate) {
    return;
  }
  if (typeof value === 'string') {
    if (!found.nul && containsNul(value)) {
      found.nul = true;
    }
    if (!found.surrogate && containsLoneSurrogate(value)) {
      found.surrogate = true;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, found);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      collect(key, found);
      collect(item, found);
    }
  }
  // Date・Uint8Array などの中は見ない（文字列として保存しない）。
}

function messagesIn(value: unknown): string[] {
  const found = { nul: false, surrogate: false };
  collect(value, found);
  const messages: string[] = [];
  if (found.nul) {
    messages.push(NUL_MESSAGE);
  }
  if (found.surrogate) {
    messages.push(LONE_SURROGATE_MESSAGE);
  }
  return messages;
}

function mergeInto(details: Record<string, string[]>, key: string, messages: string[]): void {
  if (messages.length === 0) {
    return;
  }
  const current = details[key] ?? [];
  const merged = [NUL_MESSAGE, LONE_SURROGATE_MESSAGE].filter(
    (message) => current.includes(message) || messages.includes(message),
  );
  details[key] = merged;
}

/**
 * 使えない文字を含む**最上位の項目名** → 文言（NUL → 片割れの順）。
 *
 * * 最上位がプレーンなオブジェクトなら、項目ごとに値（入れ子の値とキーを含む）を見る
 * * 最上位のキー自体に含むとき、最上位がオブジェクトでない（配列・文字列）ときは `_`
 * * 何も無ければ `{}`。送った値は載せない
 */
export function unusableTextDetailsOf(value: unknown): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      mergeInto(details, '_', messagesOf(key));
      mergeInto(details, key, messagesIn(item));
    }
    return details;
  }
  mergeInto(details, '_', messagesIn(value));
  return details;
}

/**
 * NUL と片割れを U+FFFD に置き換える（L4。Core が書く Plugin 由来・システム由来の文字列）。
 *
 * 1 文字（UTF-16 の 1 単位）を 1 文字に置き換えるので、長さは変わらない。
 * 秘匿（資格情報の伏せ字）の**後**に掛ける（設計 §9.4・§13 の 4）。
 */
export function toStorableText(value: string): string {
  return value
    .replaceAll(NUL_CHARACTER, REPLACEMENT_CHARACTER)
    .replace(LONE_SURROGATE_PATTERN_GLOBAL, REPLACEMENT_CHARACTER);
}
