import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LISTED_STATUSES,
  isSiteStatus,
  isValidSiteName,
  isValidSiteUrl,
  SITE_NAME_MAX_LENGTH,
  SITE_STATUSES,
} from './site';

describe('isValidSiteName', () => {
  it('通常の名前を受け入れる', () => {
    expect(isValidSiteName('コーポレートサイト')).toBe(true);
  });

  it('空文字を拒否する', () => {
    expect(isValidSiteName('')).toBe(false);
  });

  it('空白だけを拒否する', () => {
    expect(isValidSiteName('   ')).toBe(false);
  });

  it('上限ちょうどを受け入れる', () => {
    expect(isValidSiteName('a'.repeat(SITE_NAME_MAX_LENGTH))).toBe(true);
  });

  it('上限を超えたら拒否する', () => {
    expect(isValidSiteName('a'.repeat(SITE_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('isValidSiteUrl', () => {
  it('https を受け入れる', () => {
    expect(isValidSiteUrl('https://example.com')).toBe(true);
  });

  it('http を受け入れる', () => {
    expect(isValidSiteUrl('http://example.com/path?a=1')).toBe(true);
  });

  it('javascript: を拒否する', () => {
    // 一覧のリンクから任意のスクリプトを実行させられるため。
    expect(isValidSiteUrl('javascript:alert(1)')).toBe(false);
  });

  it('data: を拒否する', () => {
    expect(isValidSiteUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('file: を拒否する', () => {
    expect(isValidSiteUrl('file:///etc/passwd')).toBe(false);
  });

  it('スキームが無ければ拒否する', () => {
    expect(isValidSiteUrl('example.com')).toBe(false);
  });

  it('ホストが無い URL を拒否する', () => {
    // http:// は URL として解釈できず例外になる。
    expect(isValidSiteUrl('http://')).toBe(false);
  });

  it('http:///path は host=path として受け入れる', () => {
    // WHATWG URL は http:///path を http://path/ へ正規化する。
    // 見た目は不自然だが正当な URL であり、拒否する理由が無い。
    expect(isValidSiteUrl('http:///path')).toBe(true);
  });

  it('認証情報を含む URL を拒否する', () => {
    // 保存すると、一覧やログに資格情報が載る。
    expect(isValidSiteUrl('https://user:pass@example.com')).toBe(false);
    expect(isValidSiteUrl('https://user@example.com')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(isValidSiteUrl('')).toBe(false);
  });

  it('大文字のスキームも受け入れる', () => {
    // URL は protocol を小文字へ正規化する。
    expect(isValidSiteUrl('HTTPS://example.com')).toBe(true);
  });
});

describe('isSiteStatus', () => {
  it('定義済みの状態を受け入れる', () => {
    for (const status of SITE_STATUSES) {
      expect(isSiteStatus(status)).toBe(true);
    }
  });

  it('定義外を拒否する', () => {
    expect(isSiteStatus('deleted')).toBe(false);
  });
});

describe('DEFAULT_LISTED_STATUSES', () => {
  it('archived を含まない', () => {
    // 「もう使わないが記録は残す」状態は、既定の一覧に出さない。
    expect(DEFAULT_LISTED_STATUSES).not.toContain('archived');
  });

  it('active と paused を含む', () => {
    expect([...DEFAULT_LISTED_STATUSES].sort()).toEqual(['active', 'paused']);
  });
});
