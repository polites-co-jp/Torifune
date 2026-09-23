import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOAuth1Header } from '../../../../plugins/sns-x-api/oauth1';

/**
 * X 配信 Plugin（有料版・`sns-x-api`）の OAuth 1.0a の署名（037-sns-x 設計 §6.3 / §10.5 #27 / #28）。
 *
 * **公開ドキュメントの計算例を再現する**（#27）。
 * <https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature>
 *
 * 計算例の外の入力（R2 / R3 の `params: {}`、`!'()*` を含む nonce）は、このファイルに持つ
 * **参照の署名**（`node:crypto` の HMAC-SHA1。RFC 5849 §3.4.1 の手順）と突き合わせる。
 * 参照の署名が計算例を再現することも同じファイルで確かめる（参照そのものの正しさ）。
 *
 * #89：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

let realFetch: typeof globalThis.fetch;
let fetchCalls = 0;

/** 呼ばれたら投げる `fetch`（#89）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    fetchCalls += 1;
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = throwingFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 公開ドキュメントの計算例（#27）                                               */
/* -------------------------------------------------------------------------- */

const DOC_CREDENTIAL = {
  apiKey: 'xvz1evFS4wEEPTGEFPHBog',
  apiKeySecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  accessTokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
} as const;

const DOC_PARAMS = {
  include_entities: 'true',
  status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
} as const;

const DOC_NONCE = 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg';
const DOC_TIMESTAMP = 1318622958;
const DOC_URL = 'https://api.x.com/1.1/statuses/update.json';

/** 公開ドキュメントの例の署名（設計 §10.5 #27）。 */
const DOC_SIGNATURE = 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=';

/** 同じ入力で URL を旧来の `api.twitter.com` にしたときの署名（設計 §10.5 #27）。 */
const LEGACY_URL = 'https://api.twitter.com/1.1/statuses/update.json';
const LEGACY_SIGNATURE = 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=';

function docHeader(overrides: { readonly url?: string } = {}): Promise<string> {
  return buildOAuth1Header({
    method: 'POST',
    url: overrides.url ?? DOC_URL,
    params: DOC_PARAMS,
    credential: DOC_CREDENTIAL,
    nonce: DOC_NONCE,
    timestamp: DOC_TIMESTAMP,
  });
}

/* -------------------------------------------------------------------------- */
/* ヘッダの読み取りと参照の署名                                                  */
/* -------------------------------------------------------------------------- */

/** `OAuth k="v", k="v"` を読む。値は**エンコードされたまま**返す。 */
function parseHeader(header: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const match of header.slice('OAuth '.length).matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) {
    entries.set(match[1] ?? '', match[2] ?? '');
  }
  return entries;
}

function decodedSignatureOf(header: string): string {
  return decodeURIComponent(parseHeader(header).get('oauth_signature') ?? '');
}

/** RFC 3986 のエンコード（設計 §6.3：`encodeURIComponent` の後で `!'()*` を `%XX` にする）。 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 参照の署名。RFC 5849 §3.4.1 の手順を `node:crypto` で計算する（Plugin の実装とは独立）。
 * パラメータはエンコードした後でキー順（同じキーなら値順）に並べる。
 */
function referenceSignature(input: {
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly credential: Readonly<Record<keyof typeof DOC_CREDENTIAL, string>>;
  readonly nonce: string;
  readonly timestamp: number;
}): string {
  const all: Record<string, string> = {
    ...input.params,
    oauth_consumer_key: input.credential.apiKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(input.timestamp),
    oauth_token: input.credential.accessToken,
    oauth_version: '1.0',
  };
  const pairs = Object.entries(all)
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? (leftValue < rightValue ? -1 : 1) : leftKey < rightKey ? -1 : 1,
    );
  const base = [
    'POST',
    rfc3986(input.url),
    rfc3986(pairs.map(([key, value]) => `${key}=${value}`).join('&')),
  ].join('&');
  const key = `${rfc3986(input.credential.apiKeySecret)}&${rfc3986(input.credential.accessTokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

describe('参照の署名の前提', () => {
  it('参照の署名は公開ドキュメントの計算例を再現する（このファイルの突き合わせの拠り所）', () => {
    expect(
      referenceSignature({
        url: DOC_URL,
        params: DOC_PARAMS,
        credential: DOC_CREDENTIAL,
        nonce: DOC_NONCE,
        timestamp: DOC_TIMESTAMP,
      }),
    ).toBe(DOC_SIGNATURE);
    expect(
      referenceSignature({
        url: LEGACY_URL,
        params: DOC_PARAMS,
        credential: DOC_CREDENTIAL,
        nonce: DOC_NONCE,
        timestamp: DOC_TIMESTAMP,
      }),
    ).toBe(LEGACY_SIGNATURE);
  });
});

/* -------------------------------------------------------------------------- */
/* #27                                                                         */
/* -------------------------------------------------------------------------- */

describe('公開ドキュメントの計算例（#27）', () => {
  it('#27 buildOAuth1Header は Promise を返す（Web Crypto の署名は非同期）', () => {
    const result = docHeader();

    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('#27 oauth_signature をパーセントデコードすると Ls93hJiZbQ3akF3HF3x1Bz8/zU4= になる', async () => {
    expect(decodedSignatureOf(await docHeader())).toBe(DOC_SIGNATURE);
  });

  it('#27 同じ入力で URL を api.twitter.com にすると hCtSmYh+iHYCEqBWrE7C7hYmtUk= になる（URL が基底文字列に入る）', async () => {
    expect(decodedSignatureOf(await docHeader({ url: LEGACY_URL }))).toBe(LEGACY_SIGNATURE);
  });

  it('#27 params を署名に含める（params を空にすると署名が変わる）', async () => {
    const withoutParams = await buildOAuth1Header({
      method: 'POST',
      url: DOC_URL,
      params: {},
      credential: DOC_CREDENTIAL,
      nonce: DOC_NONCE,
      timestamp: DOC_TIMESTAMP,
    });

    expect(decodedSignatureOf(withoutParams)).not.toBe(DOC_SIGNATURE);
  });

  it('#27 同じ入力なら同じヘッダになる（時計も乱数も持たない）', async () => {
    expect(await docHeader()).toBe(await docHeader());
  });

  it('#27 fetch を呼ばない', async () => {
    await docHeader();

    expect(fetchCalls).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #28                                                                         */
/* -------------------------------------------------------------------------- */

describe('ヘッダの形（#28）', () => {
  it('#28 計算例のヘッダは設計 §6.3 の形そのもの（7 つの oauth_* をこの順に、値は RFC 3986 でエンコード）', async () => {
    expect(await docHeader()).toBe(
      'OAuth ' +
        [
          `oauth_consumer_key="${DOC_CREDENTIAL.apiKey}"`,
          `oauth_nonce="${DOC_NONCE}"`,
          'oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D"',
          'oauth_signature_method="HMAC-SHA1"',
          `oauth_timestamp="${DOC_TIMESTAMP}"`,
          `oauth_token="${DOC_CREDENTIAL.accessToken}"`,
          'oauth_version="1.0"',
        ].join(', '),
    );
  });

  it('#28 OAuth で始まる', async () => {
    expect((await docHeader()).startsWith('OAuth ')).toBe(true);
  });

  it('#28 oauth_* をちょうど 7 つ持つ', async () => {
    expect([...parseHeader(await docHeader()).keys()].sort()).toEqual([
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_token',
      'oauth_version',
    ]);
  });

  it('#28 params はヘッダに入れない（署名にだけ入る）', async () => {
    const header = await docHeader();

    expect(header).not.toContain('include_entities');
    expect(header).not.toContain('status=');
    expect(header).not.toContain('Gentlemen');
  });

  it("#28 値は RFC 3986 でエンコードされる（!'()* が %21 %27 %28 %29 %2A になる）", async () => {
    const header = await buildOAuth1Header({
      method: 'POST',
      url: 'https://api.x.com/2/tweets',
      params: {},
      credential: DOC_CREDENTIAL,
      nonce: "a!b'c(d)e*f",
      timestamp: DOC_TIMESTAMP,
    });

    expect(parseHeader(header).get('oauth_nonce')).toBe('a%21b%27c%28d%29e%2Af');
  });

  it("#28 !'()* を含む nonce でも、署名は RFC 3986 でエンコードした値で計算される（参照の署名と一致）", async () => {
    const nonce = "n!o'n(c)e*";
    const header = await buildOAuth1Header({
      method: 'POST',
      url: 'https://api.x.com/2/tweets',
      params: {},
      credential: DOC_CREDENTIAL,
      nonce,
      timestamp: DOC_TIMESTAMP,
    });

    expect(decodedSignatureOf(header)).toBe(
      referenceSignature({
        url: 'https://api.x.com/2/tweets',
        params: {},
        credential: DOC_CREDENTIAL,
        nonce,
        timestamp: DOC_TIMESTAMP,
      }),
    );
  });

  it.each(['https://api.x.com/2/tweets', 'https://api.x.com/2/media/upload'])(
    '#28 R2 / R3 の形（params: {}）でも参照の署名と一致する：%s',
    async (url) => {
      const header = await buildOAuth1Header({
        method: 'POST',
        url,
        params: {},
        credential: DOC_CREDENTIAL,
        nonce: DOC_NONCE,
        timestamp: DOC_TIMESTAMP,
      });

      expect(decodedSignatureOf(header)).toBe(
        referenceSignature({
          url,
          params: {},
          credential: DOC_CREDENTIAL,
          nonce: DOC_NONCE,
          timestamp: DOC_TIMESTAMP,
        }),
      );
    },
  );

  it('#28 2 つの Secret（apiKeySecret / accessTokenSecret）がヘッダに現れない（生の値もエンコードした値も）', async () => {
    const header = await docHeader();

    for (const secret of [DOC_CREDENTIAL.apiKeySecret, DOC_CREDENTIAL.accessTokenSecret]) {
      expect(header).not.toContain(secret);
      expect(header).not.toContain(rfc3986(secret));
    }
  });

  it('#28 Secret を変えると署名だけが変わる（Secret は鍵にだけ入る）', async () => {
    const other = await buildOAuth1Header({
      method: 'POST',
      url: DOC_URL,
      params: DOC_PARAMS,
      credential: { ...DOC_CREDENTIAL, accessTokenSecret: 'anotherTokenSecretValue0001' },
      nonce: DOC_NONCE,
      timestamp: DOC_TIMESTAMP,
    });
    const original = parseHeader(await docHeader());
    const changed = parseHeader(other);

    expect(changed.get('oauth_signature')).not.toBe(original.get('oauth_signature'));
    for (const key of [
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_token',
      'oauth_version',
    ]) {
      expect(changed.get(key), key).toBe(original.get(key));
    }
  });
});
