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

  it('推測できない長さがある', () => {
    expect(generateSitePublicKey().length).toBeGreaterThanOrEqual(32);
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
