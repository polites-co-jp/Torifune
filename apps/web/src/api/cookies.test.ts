import { afterEach, describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  csrfCookie,
  isSecureRequest,
  readCookie,
  requestInfoOf,
  sessionCookie,
} from './cookies';

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const http = req('http://localhost:3000/api/v1/auth/login');
const https = req('https://torifune.example.com/api/v1/auth/login');
const expiresAt = new Date('2026-09-01T00:00:00Z');

afterEach(() => {
  delete process.env['APP_ENV'];
});

describe('isSecureRequest', () => {
  it('https のリクエストでは true', () => {
    expect(isSecureRequest(https)).toBe(true);
  });

  it('http のリクエストでは false', () => {
    expect(isSecureRequest(http)).toBe(false);
  });

  it('x-forwarded-proto: https を優先する', () => {
    const behindProxy = req('http://torifune:3000/x', { 'x-forwarded-proto': 'https' });
    expect(isSecureRequest(behindProxy)).toBe(true);
  });

  it('x-forwarded-proto が複数あるとき先頭を見る', () => {
    const behindProxy = req('http://torifune:3000/x', { 'x-forwarded-proto': 'https, http' });
    expect(isSecureRequest(behindProxy)).toBe(true);
  });

  it('APP_ENV=production なら常に true', () => {
    // TLS 終端が上流にあり x-forwarded-proto が落ちていても、付け忘れより安全側に倒す。
    process.env['APP_ENV'] = 'production';
    expect(isSecureRequest(http)).toBe(true);
  });

  it('NODE_ENV では判定しない', () => {
    // next start は常に NODE_ENV=production を立てる。
    // これで判定すると、HTTP 提供の環境で Cookie が送られなくなる。
    expect(process.env['NODE_ENV']).not.toBe('production');
    expect(isSecureRequest(http)).toBe(false);
  });
});

describe('sessionCookie', () => {
  it('必ず HttpOnly が付く', () => {
    expect(sessionCookie(http, 'tok', expiresAt)).toContain('HttpOnly');
    expect(sessionCookie(https, 'tok', expiresAt)).toContain('HttpOnly');
  });

  it('SameSite が付く', () => {
    expect(sessionCookie(http, 'tok', expiresAt)).toContain('SameSite=Lax');
  });

  it('https では Secure が付く', () => {
    expect(sessionCookie(https, 'tok', expiresAt)).toContain('Secure');
  });

  it('http では Secure が付かない', () => {
    expect(sessionCookie(http, 'tok', expiresAt)).not.toContain('Secure');
  });

  it('有効期限が入る', () => {
    expect(sessionCookie(http, 'tok', expiresAt)).toContain('Expires=');
  });
});

describe('clearedSessionCookie', () => {
  it('値を空にし、Max-Age=0 を付ける', () => {
    const cookie = clearedSessionCookie(http);
    expect(cookie).toContain('torifune_session=;');
    expect(cookie).toContain('Max-Age=0');
  });

  it('消すときも HttpOnly を付ける', () => {
    expect(clearedSessionCookie(http)).toContain('HttpOnly');
  });
});

describe('csrfCookie', () => {
  it('HttpOnly を付けない（JavaScript が読む必要がある）', () => {
    expect(csrfCookie(http, 'tok')).not.toContain('HttpOnly');
  });

  it('セッションとは別の名前を使う', () => {
    expect(csrfCookie(http, 'tok')).toContain('torifune_csrf=');
  });
});

describe('readCookie', () => {
  it('該当する Cookie を返す', () => {
    const request = req('http://x/y', { cookie: 'a=1; torifune_session=abc; b=2' });
    expect(readCookie(request, 'torifune_session')).toBe('abc');
  });

  it('無ければ undefined', () => {
    const request = req('http://x/y', { cookie: 'a=1' });
    expect(readCookie(request, 'torifune_session')).toBeUndefined();
  });

  it('Cookie ヘッダが無ければ undefined', () => {
    expect(readCookie(req('http://x/y'), 'torifune_session')).toBeUndefined();
  });

  it('名前の前方一致で誤って拾わない', () => {
    const request = req('http://x/y', { cookie: 'torifune_session_backup=zzz' });
    expect(readCookie(request, 'torifune_session')).toBeUndefined();
  });
});

describe('requestInfoOf', () => {
  it('x-forwarded-for の先頭を IP とする', () => {
    const request = req('http://x/y', { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' });
    expect(requestInfoOf(request).ipAddress).toBe('203.0.113.1');
  });

  it('x-real-ip も見る', () => {
    const request = req('http://x/y', { 'x-real-ip': '203.0.113.2' });
    expect(requestInfoOf(request).ipAddress).toBe('203.0.113.2');
  });

  it('どちらも無ければ null', () => {
    expect(requestInfoOf(req('http://x/y')).ipAddress).toBeNull();
  });

  it('User-Agent を返す', () => {
    const request = req('http://x/y', { 'user-agent': 'vitest' });
    expect(requestInfoOf(request).userAgent).toBe('vitest');
  });
});
