/**
 * OAuth 1.0a（User Context）の署名と `Authorization` ヘッダの組み立て（037-sns-x 設計 §6.3）。
 *
 * **純粋な計算だけを置く。** 時計も乱数も外部 I/O も持たない。nonce と timestamp は呼ぶ側が渡す。
 * HMAC-SHA1 は Web Crypto（global の `crypto.subtle`）で計算する。依存も `node:` の import も足さない。
 *
 * 手順は RFC 5849 §3.4.1 と X の公開ドキュメントの計算例のとおり。正しさは計算例を再現するテストが固定している
 * （設計 §10.5 の #27）。
 *
 * **署名の基底文字列・鍵・ヘッダの値をログにも `reason` にも渡さない**（設計 §6.9）。
 */

/** 資格情報の 4 値（`credentialFields` のキーのまま。設計 §5.1）。 */
export interface OAuth1Credential {
  readonly apiKey: string;
  readonly apiKeySecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

export interface OAuth1HeaderInput {
  readonly method: 'POST';
  /** 要求の URL。**クエリを含めない**（R2 / R3 はクエリを持たない）。 */
  readonly url: string;
  /**
   * 署名に含める form / クエリの値。R2（multipart）と R3（JSON）の本体は署名に含めないので、実際の配信では常に `{}`。
   * 引数に持つのは公開ドキュメントの計算例を再現するため（設計 §6.3）。
   */
  readonly params: Readonly<Record<string, string>>;
  readonly credential: OAuth1Credential;
  readonly nonce: string;
  /** UNIX 秒。 */
  readonly timestamp: number;
}

const SIGNATURE_METHOD = 'HMAC-SHA1';
const OAUTH_VERSION = '1.0';

/**
 * RFC 3986 のパーセントエンコード。
 *
 * `encodeURIComponent` は `!'()*` の 5 文字をエンコードせずに残すので、その後で `%XX` にする。
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 基底文字列に入れる URL（RFC 5849 §3.4.1.2）。
 *
 * スキームとホストは小文字、既定のポートは落とし、クエリとフラグメントを含めない。
 * `URL` の解析結果がこの正規形をそのまま持つ（R2 / R3 の URL はもともと正規形）。
 */
function baseStringUri(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** 2 つの文字列を UTF-16 の単位で比べる（RFC 5849 §3.4.1.3.2 はバイト順。エンコード後は ASCII なので同じ）。 */
function compareAscii(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 の符号化（パディングあり）。
 *
 * 設計 §4 の「使ってよい global」に base64 の手段が無いので手で書く（実装プラン §8 の 7）。
 */
function toBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64_ALPHABET[(chunk >> 18) & 0x3f] ?? '';
    output += BASE64_ALPHABET[(chunk >> 12) & 0x3f] ?? '';
    output += second === undefined ? '=' : (BASE64_ALPHABET[(chunk >> 6) & 0x3f] ?? '');
    output += third === undefined ? '=' : (BASE64_ALPHABET[chunk & 0x3f] ?? '');
  }
  return output;
}

/** HMAC-SHA1 を base64 にしたもの。Web Crypto の署名は非同期。 */
async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return toBase64(new Uint8Array(signature));
}

/**
 * `Authorization` ヘッダの値（`OAuth oauth_consumer_key="…", …`）を作る（設計 §6.3）。
 *
 * 1. oauth_* の 6 つと `params` を RFC 3986 でエンコードし、キー順（同じキーなら値順）に並べて `&` で繋ぐ
 * 2. `POST&<エンコードした URL>&<エンコードしたパラメータ列>` を基底文字列にする
 * 3. 鍵 `<エンコードした apiKeySecret>&<エンコードした accessTokenSecret>` で HMAC-SHA1、base64
 * 4. 署名を加えた oauth_* の 7 つを `key="エンコードした値"` にして `, ` で繋ぐ（`params` はヘッダに入れない）
 *
 * **2 つの Secret は鍵にだけ入り、ヘッダには現れない。**
 */
export async function buildOAuth1Header(input: OAuth1HeaderInput): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.credential.apiKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: String(input.timestamp),
    oauth_token: input.credential.accessToken,
    oauth_version: OAUTH_VERSION,
  };

  const pairs = [...Object.entries(input.params), ...Object.entries(oauth)]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? compareAscii(leftValue, rightValue) : compareAscii(leftKey, rightKey),
    );
  const parameterString = pairs.map(([key, value]) => `${key}=${value}`).join('&');

  const baseString = [
    input.method,
    encodeRfc3986(baseStringUri(input.url)),
    encodeRfc3986(parameterString),
  ].join('&');
  const signingKey = `${encodeRfc3986(input.credential.apiKeySecret)}&${encodeRfc3986(
    input.credential.accessTokenSecret,
  )}`;

  const signed: Record<string, string> = {
    ...oauth,
    oauth_signature: await hmacSha1Base64(signingKey, baseString),
  };
  const fields = Object.keys(signed)
    .sort(compareAscii)
    .map((key) => `${encodeRfc3986(key)}="${encodeRfc3986(signed[key] ?? '')}"`);
  return `OAuth ${fields.join(', ')}`;
}
