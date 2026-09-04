import { describe, expect, it } from 'vitest';
import {
  countsTowardMetrics,
  deviceKindOf,
  generateSitePublicKey,
  normalizePath,
  referrerHostOf,
  visitorHash,
} from './access-log';

describe('generateSitePublicKey', () => {
  it('毎回異なる', () => {
    expect(generateSitePublicKey()).not.toBe(generateSitePublicKey());
  });

  /**
   * 028 設計 §6.6（受け入れ条件 #43 の Domain 側）。
   * `randomBytes(32).toString('hex')` で 64 桁にし、DB の既定値と長さを揃える。
   */
  it('64 桁の 16 進になる', () => {
    expect(generateSitePublicKey()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('visitorHash', () => {
  const base = {
    dailySalt: 'salt-2026-04-01',
    siteId: 'site-1',
    ipAddress: '203.0.113.5',
    userAgent: 'Mozilla/5.0',
  };

  it('同じ入力なら同じ値になる', () => {
    expect(visitorHash(base)).toBe(visitorHash(base));
  });

  /**
   * ソルトを日ごとに変えるので、日をまたぐと同じ人でも別の値になる。
   * 同じ訪問者を日をまたいで数えられなくなるが、追跡できないことのほうが重要。
   */
  it('ソルトが変わると値が変わる', () => {
    expect(visitorHash({ ...base, dailySalt: 'salt-2026-04-02' })).not.toBe(visitorHash(base));
  });

  it('サイトが違えば値が変わる', () => {
    expect(visitorHash({ ...base, siteId: 'site-2' })).not.toBe(visitorHash(base));
  });

  it('IPが違えば値が変わる', () => {
    expect(visitorHash({ ...base, ipAddress: '198.51.100.1' })).not.toBe(visitorHash(base));
  });

  /** ハッシュから元の値が読めない。 */
  it('元の値を含まない', () => {
    const hash = visitorHash(base);
    expect(hash).not.toContain('203.0.113.5');
    expect(hash).not.toContain('Mozilla');
  });
});

describe('normalizePath', () => {
  it('パスをそのまま返す', () => {
    expect(normalizePath('/blog/post')).toBe('/blog/post');
  });

  /** トークンや個人情報が URL に入ることがある。 */
  it('クエリ文字列を落とす', () => {
    expect(normalizePath('/search?q=secret&token=abc')).toBe('/search');
  });

  it('フラグメントを落とす', () => {
    expect(normalizePath('/docs#section')).toBe('/docs');
  });

  it('絶対URLからパスだけを取る', () => {
    expect(normalizePath('https://example.com/a/b?x=1')).toBe('/a/b');
  });

  it('長すぎるパスを切る', () => {
    expect(normalizePath(`/${'a'.repeat(600)}`)?.length).toBe(500);
  });

  it.each(['', '   ', 'not-a-path', 'javascript:alert(1)'])('受け付けない: %s', (value) => {
    expect(normalizePath(value)).toBeNull();
  });

  /**
   * 制御文字（0x00〜0x1f、0x7f）を含むパスは記録しない（018 設計 §3.2 の正規化規則、
   * 028 の検証で追記）。
   *
   * 記録すると、ロールアップがその key で `path_pageviews` 等を書き、画面が読んだ key を
   * `listAnalyticsBreakdown` の `keys` へ渡したときに `isValidBreakdownKey` で弾かれて
   * 「ページ」タブが落ちる。入口で落とすのが最も安い。
   */
  it.each([
    ['U+0001', '/a\u0001b'],
    ['NUL（U+0000）', '/a\u0000'],
    ['DEL（U+007F）', '/a\u007f'],
    ['途中の改行', '/a\nb'],
    ['タブ', '/a\tb'],
    ['途中の CR', '/a\rb'],
    ['境界の U+001F', '/a\u001fb'],
  ])('制御文字を含むパスは受け付けない: %s', (_label, value) => {
    expect(normalizePath(value)).toBeNull();
  });

  /** 前後の空白は trim で落ちるので、先頭の改行だけなら通常どおりパスになる。 */
  it('先頭の改行は trim で落ちて、残りが正しいパスなら受け付ける', () => {
    expect(normalizePath('\n/a')).toBe('/a');
  });

  /** 制御文字でなければ従来どおり。 */
  it('日本語を含むパスをそのまま返す', () => {
    expect(normalizePath('/ブログ/記事')).toBe('/ブログ/記事');
  });

  it('途中に空白を含むパスをそのまま返す', () => {
    expect(normalizePath('/a b')).toBe('/a b');
  });
});

describe('referrerHostOf', () => {
  /** パスまで持つと、他サイト上で何を見ていたかが残る。 */
  it('ホストだけを返す', () => {
    expect(referrerHostOf('https://example.com/secret/path?q=1')).toBe('example.com');
  });

  it.each([null, undefined, '', '   ', 'not a url'])('取れなければ null: %s', (value) => {
    expect(referrerHostOf(value)).toBeNull();
  });
});

describe('deviceKindOf', () => {
  it('デスクトップを見分ける', () => {
    expect(deviceKindOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
  });

  it('モバイルを見分ける', () => {
    expect(deviceKindOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148')).toBe('mobile');
  });

  it('タブレットを見分ける', () => {
    expect(deviceKindOf('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet');
  });

  it.each([
    'Googlebot/2.1',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'curl/8.0',
    'python-requests/2.31',
    'HeadlessChrome/120',
  ])('Bot を見分ける: %s', (ua) => {
    expect(deviceKindOf(ua)).toBe('bot');
  });

  /** 通常のブラウザは必ず送る。無いものは Bot として扱う。 */
  it.each([null, undefined, '', '   '])('User-Agent が無ければ bot: %s', (ua) => {
    expect(deviceKindOf(ua)).toBe('bot');
  });
});

describe('countsTowardMetrics', () => {
  /** Bot を数えると、数字が実態から離れる。 */
  it('Bot は数えない', () => {
    expect(countsTowardMetrics('bot')).toBe(false);
  });

  it.each(['desktop', 'mobile', 'tablet'] as const)('%s は数える', (device) => {
    expect(countsTowardMetrics(device)).toBe(true);
  });
});
