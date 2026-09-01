import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  isRetryable,
  isValidWebhookName,
  isValidWebhookUrl,
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
  signPayload,
  verifySignature,
} from './webhook';

describe('isValidWebhookUrl', () => {
  it('https を受け入れる', () => {
    expect(isValidWebhookUrl('https://hooks.example.com/torifune')).toBe(true);
  });

  /** 平文で送ると、署名があっても中身は読まれる。 */
  it('http を受け入れない', () => {
    expect(isValidWebhookUrl('http://hooks.example.com/torifune')).toBe(false);
  });

  it('開発用の localhost だけ http を許す', () => {
    expect(isValidWebhookUrl('http://localhost:9000/hook')).toBe(true);
    expect(isValidWebhookUrl('http://127.0.0.1:9000/hook')).toBe(true);
  });

  /** 保存すると一覧やログに資格情報が載る。 */
  it('URL に資格情報を書かせない', () => {
    expect(isValidWebhookUrl('https://user:pass@hooks.example.com/x')).toBe(false);
  });

  it.each(['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)'])(
    '不正な URL を受け入れない: %s',
    (value) => {
      expect(isValidWebhookUrl(value)).toBe(false);
    },
  );

  /**
   * 内部ネットワークへの送信は止めない。自己ホストで社内の受け手へ送るのは
   * 正当な用途で、塞ぐと使えない（設計 §3.7）。
   */
  it('内部ネットワークの https は受け入れる', () => {
    expect(isValidWebhookUrl('https://intranet.local/hook')).toBe(true);
  });
});

describe('generateWebhookSecret', () => {
  it('毎回異なる', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });

  it('見分けられる接頭辞を付ける', () => {
    expect(generateWebhookSecret().startsWith('whsec_')).toBe(true);
  });

  it('総当たりできない長さがある', () => {
    expect(generateWebhookSecret().length).toBeGreaterThan(40);
  });
});

describe('signPayload', () => {
  const secret = 'whsec_test';
  const body = '{"event":"site.created"}';

  it('同じ入力なら同じ署名', () => {
    expect(signPayload(secret, 100, body)).toBe(signPayload(secret, 100, body));
  });

  /** 本文だけに署名すると、古い配信をそのまま送りつけられる（リプレイ）。 */
  it('時刻が違えば署名も変わる', () => {
    expect(signPayload(secret, 100, body)).not.toBe(signPayload(secret, 101, body));
  });

  it('本文が違えば署名も変わる', () => {
    expect(signPayload(secret, 100, body)).not.toBe(signPayload(secret, 100, `${body} `));
  });

  it('Secret が違えば署名も変わる', () => {
    expect(signPayload(secret, 100, body)).not.toBe(signPayload('whsec_other', 100, body));
  });

  it('署名に Secret が現れない', () => {
    expect(signPayload(secret, 100, body)).not.toContain('test');
  });
});

describe('verifySignature', () => {
  const secret = 'whsec_test';
  const body = '{"event":"site.created"}';

  it('正しい署名を受け入れる', () => {
    expect(verifySignature(secret, 100, body, signPayload(secret, 100, body))).toBe(true);
  });

  it.each([
    ['時刻が違う', 101, body, 'whsec_test'],
    ['本文が違う', 100, `${body} `, 'whsec_test'],
    ['Secret が違う', 100, body, 'whsec_other'],
  ])('違う入力の署名を拒む: %s', (_label, timestamp, payload, otherSecret) => {
    const signature = signPayload(otherSecret, timestamp, payload);
    expect(verifySignature(secret, 100, body, signature)).toBe(false);
  });

  it('長さが違う署名を拒む', () => {
    expect(verifySignature(secret, 100, body, 'short')).toBe(false);
  });
});

describe('再試行', () => {
  /** 落ちている受け手を叩き続けない。 */
  it('回数が増えるほど間隔が空く', () => {
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    expect(retryDelayMs(3)).toBeGreaterThan(retryDelayMs(2));
  });

  it('上限まで試したら諦める', () => {
    expect(isRetryable(MAX_DELIVERY_ATTEMPTS - 1)).toBe(true);
    expect(isRetryable(MAX_DELIVERY_ATTEMPTS)).toBe(false);
  });
});

describe('isValidWebhookName', () => {
  it.each(['Slack 通知', 'a'.repeat(100)])('受け入れる: %s', (value) => {
    expect(isValidWebhookName(value)).toBe(true);
  });

  it.each(['', '   ', 'a'.repeat(101)])('拒否する: %s', (value) => {
    expect(isValidWebhookName(value)).toBe(false);
  });
});
