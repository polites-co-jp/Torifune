/**
 * アクセスログの除外IP（033-analytics-ip-exclusion 設計 §4）。
 *
 * **Domain 層。** DB も HTTP も知らない。文字列を受けて真偽を返すだけにする。
 *
 * ここに置く理由は 2 つある。
 *
 * * **記録の手前でしか除外できない。** `access_logs` に IP は保存されず、
 *   `visitor_hash` の材料である日次ソルトも保存しないので（018 設計 §3.2）、
 *   後から「この IP の行」を探して消すことはできない。判定は計測の受け口で行う
 * * **判定を 1 か所に閉じる。** 画面・API・受け口が別々の解釈をすると、
 *   「設定したのに記録された」が起きる。表記の揺れの吸収もここでやる
 *
 * 外部ライブラリを足さない（CLAUDE.md「UIライブラリは導入しない」と同じ理由で、
 * この程度の解釈のために依存を増やさない）。
 */

/** ルール 1 行の長さの上限。IPv6 の CIDR（最長 43 文字）に十分な余白を持たせる。 */
export const IP_EXCLUSION_RULE_MAX_LENGTH = 64;

/**
 * ルールの件数の上限。
 *
 * **判定コストの上限でもある。** 計測 1 件ごとに最大この回数だけ比較する。
 */
export const IP_EXCLUSION_MAX_RULES = 100;

export type IpFamily = 'v4' | 'v6';

export interface ParsedIp {
  readonly family: IpFamily;
  /** v4 は 4 バイト、v6 は 16 バイト。 */
  readonly bytes: Uint8Array;
}

export interface IpExclusionRule {
  readonly family: IpFamily;
  /** ホスト部を 0 でマスク済み。 */
  readonly bytes: Uint8Array;
  readonly prefixLength: number;
  /** 正規表記。保存と画面表示はこの形にそろえる。 */
  readonly text: string;
}

export interface IpExclusionParseResult {
  /** 正規化・重複除去済み。入力順を保つ。 */
  readonly rules: readonly IpExclusionRule[];
  /** 解釈できなかった行（入力のまま）。 */
  readonly invalid: readonly string[];
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP_PATTERN = /^[0-9a-fA-F]{1,4}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;

/**
 * IPv4 を 4 バイトへ。
 *
 * **先頭ゼロを認めない。** `010` を 8（8進）と読む実装があり、
 * 認めると同じ端末が表記によって別物になる。
 */
function parseIpv4Bytes(text: string): Uint8Array | null {
  const matched = IPV4_PATTERN.exec(text);
  if (matched === null) {
    return null;
  }

  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const group = matched[index + 1] ?? '';
    if (group.length > 1 && group.startsWith('0')) {
      return null;
    }
    const value = Number(group);
    if (value > 255) {
      return null;
    }
    bytes[index] = value;
  }
  return bytes;
}

/**
 * IPv6 を 16 バイトへ。
 *
 * `::` による省略は 1 回まで。末尾に IPv4 表記を埋め込む形を認める。
 * ゾーン ID（`%eth0`）は落としてから解釈する。
 */
function parseIpv6Bytes(raw: string): Uint8Array | null {
  const zoneAt = raw.indexOf('%');
  let text = zoneAt === -1 ? raw : raw.slice(0, zoneAt);

  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) {
    return null;
  }

  // 末尾の IPv4 表記を 2 つの 16 進グループへ置き換える。
  const lastGroup = text.slice(lastColon + 1);
  if (lastGroup.includes('.')) {
    const embedded = parseIpv4Bytes(lastGroup);
    if (embedded === null) {
      return null;
    }
    const high = (((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0)).toString(16);
    const low = (((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const sides = text.split('::');
  if (sides.length > 2) {
    return null;
  }

  const headText = sides[0] ?? '';
  const tailText = sides.length === 2 ? (sides[1] ?? '') : null;
  const head = headText === '' ? [] : headText.split(':');
  const tail = tailText === null ? null : tailText === '' ? [] : tailText.split(':');

  const groups = [...head, ...(tail ?? [])];
  if (groups.some((group) => !IPV6_GROUP_PATTERN.test(group))) {
    return null;
  }

  if (tail === null) {
    // 省略が無いなら、ちょうど 8 グループでなければならない。
    if (head.length !== 8) {
      return null;
    }
  } else if (groups.length > 7) {
    // `::` は 1 グループ以上を表す。
    return null;
  }

  const bytes = new Uint8Array(16);
  const fill = (target: readonly string[], offset: number): void => {
    target.forEach((group, index) => {
      const value = Number.parseInt(group, 16);
      bytes[offset + index * 2] = (value >> 8) & 0xff;
      bytes[offset + index * 2 + 1] = value & 0xff;
    });
  };

  fill(head, 0);
  if (tail !== null) {
    fill(tail, 16 - tail.length * 2);
  }
  return bytes;
}

/** IPv4 射影アドレス（`::ffff:a.b.c.d`）か。 */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * アドレスを読む。**例外を投げない**（計測のホットパスから呼ばれる）。
 *
 * **IPv4 射影アドレスは v4 の 4 バイトへ畳む。** 畳まないと、同じ端末が
 * Proxy の設定次第で `203.0.113.10` にも `::ffff:203.0.113.10` にもなり、
 * 片方だけ除外される（設計 §4.1）。
 */
export function parseIpAddress(raw: string): ParsedIp | null {
  const text = raw.trim();
  if (text === '') {
    return null;
  }

  const v4 = parseIpv4Bytes(text);
  if (v4 !== null) {
    return { family: 'v4', bytes: v4 };
  }

  if (!text.includes(':')) {
    return null;
  }

  const v6 = parseIpv6Bytes(text);
  if (v6 === null) {
    return null;
  }

  return isIpv4Mapped(v6) ? { family: 'v4', bytes: v6.slice(12) } : { family: 'v6', bytes: v6 };
}

function formatIpv4(bytes: Uint8Array): string {
  return [...bytes].join('.');
}

/**
 * IPv6 の正規表記。小文字、ゼロの最長連（2 組以上）を `::` へ 1 回だけ畳む。
 *
 * **表記を 1 つに決める。** 決めないと、同じアドレスが複数行として保存される。
 */
function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)) >>> 0);
  }

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;

  groups.forEach((group, index) => {
    if (group === 0) {
      runStart = runStart === -1 ? index : runStart;
      const length = index - runStart + 1;
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
    } else {
      runStart = -1;
    }
  });

  const texts = groups.map((group) => group.toString(16));
  if (bestLength < 2) {
    return texts.join(':');
  }

  const head = texts.slice(0, bestStart).join(':');
  const tail = texts.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

function formatIp(parsed: ParsedIp): string {
  return parsed.family === 'v4' ? formatIpv4(parsed.bytes) : formatIpv6(parsed.bytes);
}

/**
 * 送信元アドレスを読む（設計 §4.2）。
 *
 * `x-forwarded-for` / `x-real-ip` の値は Proxy の実装ごとに揺れる。
 * 角括弧・ポート・ゾーン ID を落としてから解釈する。
 *
 * **ポートを落とすのは曖昧さが無いときだけ。** コロンが 1 個で、その前が
 * IPv4 として読めるときに限る。素の IPv6（コロンが複数）からは落とさない。
 */
function parseClientIp(raw: string | null | undefined): ParsedIp | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let text = raw.trim();
  if (text === '') {
    return null;
  }

  if (text.startsWith('[')) {
    const closing = text.indexOf(']');
    if (closing === -1) {
      return null;
    }
    const rest = text.slice(closing + 1);
    if (rest !== '' && !rest.startsWith(':')) {
      return null;
    }
    text = text.slice(1, closing);
  } else {
    const colonAt = text.indexOf(':');
    if (colonAt !== -1 && text.indexOf(':', colonAt + 1) === -1) {
      const host = text.slice(0, colonAt);
      const port = text.slice(colonAt + 1);
      if (DECIMAL_PATTERN.test(port) && parseIpv4Bytes(host) !== null) {
        text = host;
      }
    }
  }

  return parseIpAddress(text);
}

/**
 * 送信元アドレスを正規表記へそろえる。読めなければ `null`。
 *
 * **この正規化を `visitorHash` の入力に持ち込まない**（設計 §4.2）。
 * ハッシュの材料を変えると、その日の訪問者ハッシュが途中で変わり、
 * 同じ人が 2 人と数えられる。
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  const parsed = parseClientIp(raw);
  return parsed === null ? null : formatIp(parsed);
}

/** ホスト部を 0 でマスクする。 */
function maskBytes(bytes: Uint8Array, prefixLength: number): Uint8Array {
  const masked = new Uint8Array(bytes);
  const fullBytes = prefixLength >> 3;
  const remainder = prefixLength & 7;

  if (remainder !== 0) {
    masked[fullBytes] = (masked[fullBytes] ?? 0) & ((0xff << (8 - remainder)) & 0xff);
  }
  for (let index = fullBytes + (remainder === 0 ? 0 : 1); index < masked.length; index += 1) {
    masked[index] = 0;
  }
  return masked;
}

/**
 * ルールを読む（設計 §4.3）。
 *
 * **ホスト部はマスクして正規化する。** `203.0.113.10/24` は `203.0.113.0/24` として扱う。
 * 書いた人の意図（帯を指す）と保存された値をそろえ、
 * 同じ帯が 2 通りの表記で 2 行になることを防ぐ。
 */
export function parseIpExclusionRule(raw: string): IpExclusionRule | null {
  const text = raw.trim();
  if (text === '' || text.length > IP_EXCLUSION_RULE_MAX_LENGTH) {
    return null;
  }

  const parts = text.split('/');
  if (parts.length > 2) {
    return null;
  }

  const parsed = parseIpAddress(parts[0] ?? '');
  if (parsed === null) {
    return null;
  }

  const maxPrefix = parsed.family === 'v4' ? 32 : 128;
  const prefixText = parts[1];
  let prefixLength = maxPrefix;

  if (prefixText !== undefined) {
    // 先頭ゼロを認めない（`/024` を通すと表記が 2 通りになる）。
    if (!DECIMAL_PATTERN.test(prefixText)) {
      return null;
    }
    prefixLength = Number(prefixText);
    if (prefixLength > maxPrefix) {
      return null;
    }
  }

  const bytes = maskBytes(parsed.bytes, prefixLength);
  const address = formatIp({ family: parsed.family, bytes });

  return {
    family: parsed.family,
    bytes,
    prefixLength,
    text: prefixLength === maxPrefix ? address : `${address}/${prefixLength}`,
  };
}

/** ルールとアドレスの照合。先頭 `prefixLength` ビットを比べる。 */
function matchesParsed(rule: IpExclusionRule, ip: ParsedIp): boolean {
  // **family が違えば一致しない。** IPv4 射影は `parseIpAddress` が v4 へ畳んである。
  if (rule.family !== ip.family) {
    return false;
  }

  const fullBytes = rule.prefixLength >> 3;
  const remainder = rule.prefixLength & 7;

  for (let index = 0; index < fullBytes; index += 1) {
    if (rule.bytes[index] !== ip.bytes[index]) {
      return false;
    }
  }

  if (remainder === 0) {
    return true;
  }

  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((rule.bytes[fullBytes] ?? 0) & mask) === ((ip.bytes[fullBytes] ?? 0) & mask);
}

/** 1 つのルールに当たるか。送信元は生の値でよい（中で正規化する）。 */
export function matchesIpExclusionRule(
  rule: IpExclusionRule,
  rawIp: string | null | undefined,
): boolean {
  const ip = parseClientIp(rawIp);
  return ip !== null && matchesParsed(rule, ip);
}

/**
 * どれか 1 つでも当たるか。
 *
 * **読めないアドレスは一致しない。** IP が分からないものを落とすと、
 * Proxy の設定ミスで計測が全損する（設計 §6.4）。
 */
export function matchesAnyIpExclusion(
  rules: readonly IpExclusionRule[],
  rawIp: string | null | undefined,
): boolean {
  if (rules.length === 0) {
    return false;
  }

  const ip = parseClientIp(rawIp);
  if (ip === null) {
    return false;
  }

  return rules.some((rule) => matchesParsed(rule, ip));
}

/**
 * 行の並びを読む（設計 §4.5）。
 *
 * 空行は落とし、正規表記が同じ行は 1 つに畳む。
 * 解釈できなかった行は入力のまま `invalid` へ入れる——**黙って捨てない。**
 * 捨てると「書いたのに効かない」が誰にも見えなくなる。
 */
export function parseIpExclusionRules(inputs: readonly string[]): IpExclusionParseResult {
  const rules: IpExclusionRule[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    if (input.trim() === '') {
      continue;
    }

    const rule = parseIpExclusionRule(input);
    if (rule === null) {
      invalid.push(input);
      continue;
    }
    if (seen.has(rule.text)) {
      continue;
    }
    seen.add(rule.text);
    rules.push(rule);
  }

  return { rules, invalid };
}
