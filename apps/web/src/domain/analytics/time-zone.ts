/**
 * タイムゾーン**名そのもの**の扱い（032-timezone-setting 設計 §5.3）。
 *
 * `day.ts` は「境目の計算」、ここは「名前の扱い」。役割を分けてあるので、
 * `day.ts` の既存 export は 1 文字も動かさない。
 *
 * **`isValidTimeZone` だけでは保存の入口として緩すぎる。**
 * `Intl` は `Japan` / `US/Pacific` のような別名も、`+09:00` のような固定オフセットも通す。
 *
 * * 別名をそのまま保存すると、画面の一覧に一致する項目が無くなり選択欄が空になる。
 *   **保存する値は必ず正規化後**（`canonicalTimeZone`）にする
 * * 固定オフセットは一覧に無く、「どの地域の 1 日か」を画面で説明できない。
 *   `isSelectableTimeZone`（正規化後の値が一覧にある）1 つで弾く
 *
 * **純関数だけ。** `Intl` 以外に依存しない（DB も環境変数も読まない）。
 */

export interface TimeZoneOption {
  /** 保存する値（IANA 名）。 */
  readonly value: string;
  /** 画面に出す文字列（`Asia/Tokyo (GMT+09:00)`）。 */
  readonly label: string;
}

export interface TimeZoneGroup {
  /** `<optgroup label="…">` に使う地域名。 */
  readonly region: string;
  readonly options: readonly TimeZoneOption[];
}

/**
 * 地域を持たない値（`UTC` と、素性の分からない保存済みの値）を入れる群。
 *
 * **先頭に置く。** 既定値が一覧の末尾に埋もれると探せない。
 */
const ROOT_REGION = 'UTC';

/**
 * IANA 名を正規化する。解釈できなければ `null`。
 *
 * **入力を trim しない。** `'UTC '`（末尾に空白）は解釈できない値として扱う。
 * 空白を黙って落とすと、画面から来た値と保存済みの値の同一性が曖昧になる。
 */
export function canonicalTimeZone(value: string): string | null {
  if (value === '') {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * 実行環境が知っているタイムゾーンの一覧。
 *
 * `Intl.supportedValuesOf('timeZone')` は `地域/都市` の形だけを返し、**`UTC` を含まない。**
 * 既定値が一覧に無いと選び直せないので先頭へ足す。
 *
 * `Intl.supportedValuesOf` が無い実行環境（ICU を削ったビルド）では `['UTC']` だけになる。
 * そのときも保存済みの値が選択欄から消えないよう、`timeZoneOptions` が `extra` を混ぜる。
 */
function buildTimeZoneList(): readonly string[] {
  let supported: readonly string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      supported = Intl.supportedValuesOf('timeZone');
    }
  } catch {
    supported = [];
  }
  return Object.freeze([...new Set(['UTC', ...supported])]);
}

/** **呼ぶたびに組み立て直さない。** 418 件の重複除去を描画のたびに走らせない。 */
const TIME_ZONES = buildTimeZoneList();

/** 選べるタイムゾーンの一覧（`UTC` が先頭。重複は無い）。 */
export function listTimeZones(): readonly string[] {
  return TIME_ZONES;
}

/**
 * 保存を許すか。**正規化した値が一覧に含まれること。**
 *
 * `Etc/GMT+5` や `+09:00` は `isValidTimeZone` を通るが、一覧に無いので `false`。
 */
export function isSelectableTimeZone(value: string): boolean {
  const canonical = canonicalTimeZone(value);
  return canonical !== null && TIME_ZONES.includes(canonical);
}

/** `Asia/Tokyo` → `Asia`。`/` を持たない値は先頭の群へ。 */
function regionOf(value: string): string {
  const slash = value.indexOf('/');
  return slash < 0 ? ROOT_REGION : value.slice(0, slash);
}

/**
 * 現在のオフセットを添えたラベル。
 *
 * オフセットは**描画時点**のもの。夏時間の切り替わりをまたぐと実際とずれるが、
 * 選ぶ対象は地域名であってオフセットではない（設計 §11 未決 #9）。
 * 取れない値（一覧に無い保存済みの値）は名前だけを返す。
 */
function labelOf(value: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: value,
      timeZoneName: 'longOffset',
    }).formatToParts(now);
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    return offset === '' ? value : `${value} (${offset})`;
  } catch {
    return value;
  }
}

/**
 * 画面へ渡す選択肢。地域ごとにまとめ、現在のオフセットを添える。
 *
 * **`extra` を必ず混ぜる。** 一覧に無い値が保存されていても選択欄から消えない
 * （消えると選択欄が空で表示され、何が効いているのか分からなくなる）。
 * 重複しても項目は 1 度しか出ない。
 */
export function timeZoneOptions(now: Date, extra: readonly string[]): readonly TimeZoneGroup[] {
  const values = [...new Set([...TIME_ZONES, ...extra])];
  const groups = new Map<string, TimeZoneOption[]>();

  for (const value of values) {
    const region = regionOf(value);
    const options = groups.get(region);
    const option: TimeZoneOption = { value, label: labelOf(value, now) };
    if (options === undefined) {
      groups.set(region, [option]);
    } else {
      options.push(option);
    }
  }

  return [...groups].map(([region, options]) => ({ region, options }));
}
