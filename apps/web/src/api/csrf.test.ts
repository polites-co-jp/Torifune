import { describe, expect, it } from 'vitest';
import { generateCsrfToken, isSameOriginRequest, verifyCsrf } from './csrf';

/**
 * Next.js は Route Handler の `request.url` を localhost に正規化するため、
 * 判定は Host ヘッダを基準にする。テストでも Host を明示する。
 */
function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/v1/auth/login', {
    method: 'POST',
    headers: { host: 'torifune.example.com', ...headers },
  });
}

describe('generateCsrfToken', () => {
  it('毎回異なる値を返す', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
    expect(seen.size).toBe(50);
  });

  it('URL に安全な文字だけを含む', () => {
    expect(generateCsrfToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('isSameOriginRequest', () => {
  it('Origin が一致すれば true', () => {
    expect(isSameOriginRequest(req({ origin: 'https://torifune.example.com' }))).toBe(true);
  });

  it('Origin が異なれば false', () => {
    expect(isSameOriginRequest(req({ origin: 'https://evil.example.com' }))).toBe(false);
  });

  it('スキームが違っても、ホストが同じなら true', () => {
    // TLS 終端が Reverse Proxy にあると、Origin は https でもアプリには http で届く。
    // スキームで弾くと本番だけ通らなくなる。
    expect(isSameOriginRequest(req({ origin: 'http://torifune.example.com' }))).toBe(true);
  });

  it('x-forwarded-host を優先する', () => {
    expect(
      isSameOriginRequest(
        req({ origin: 'https://public.example.com', 'x-forwarded-host': 'public.example.com' }),
      ),
    ).toBe(true);
  });

  it('Host ヘッダが無ければ false', () => {
    const request = new Request('http://localhost:3000/x', {
      method: 'POST',
      headers: { origin: 'https://torifune.example.com' },
    });
    expect(isSameOriginRequest(request)).toBe(false);
  });

  it('ポートが違えば false', () => {
    expect(isSameOriginRequest(req({ origin: 'https://torifune.example.com:8443' }))).toBe(false);
  });

  it('Sec-Fetch-Site: same-origin なら true', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('Sec-Fetch-Site: cross-site なら false', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('Origin も Sec-Fetch-Site も無ければ false', () => {
    // 判断材料が無いときは拒否する。通してしまうと、
    // ヘッダを送らないクライアントから CSRF を通せる。
    expect(isSameOriginRequest(req({}))).toBe(false);
  });

  it('Origin が壊れていれば false', () => {
    expect(isSameOriginRequest(req({ origin: 'not a url' }))).toBe(false);
  });

  it('Sec-Fetch-Site があっても Origin が異なれば false', () => {
    expect(
      isSameOriginRequest(
        req({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example.com' }),
      ),
    ).toBe(false);
  });
});

describe('verifyCsrf', () => {
  const token = 'token-abc';

  it('Origin と二重送信トークンが揃っていれば通す', () => {
    const request = req({ origin: 'https://torifune.example.com', 'x-csrf-token': token });
    expect(verifyCsrf(request, { cookieToken: token })).toBe(true);
  });

  it('Cookie のトークンが無ければ拒否する', () => {
    const request = req({ origin: 'https://torifune.example.com', 'x-csrf-token': token });
    expect(verifyCsrf(request, { cookieToken: undefined })).toBe(false);
  });

  it('送信されたトークンが無ければ拒否する', () => {
    const request = req({ origin: 'https://torifune.example.com' });
    expect(verifyCsrf(request, { cookieToken: token })).toBe(false);
  });

  it('トークンが一致しなければ拒否する', () => {
    const request = req({ origin: 'https://torifune.example.com', 'x-csrf-token': 'other' });
    expect(verifyCsrf(request, { cookieToken: token })).toBe(false);
  });

  it('Origin が異なればトークンが合っていても拒否する', () => {
    const request = req({ origin: 'https://evil.example.com', 'x-csrf-token': token });
    expect(verifyCsrf(request, { cookieToken: token })).toBe(false);
  });

  it('ボディから渡されたトークンも受け付ける', () => {
    const request = req({ origin: 'https://torifune.example.com' });
    expect(verifyCsrf(request, { cookieToken: token, bodyToken: token })).toBe(true);
  });

  it('空文字のトークン同士は一致とみなさない', () => {
    const request = req({ origin: 'https://torifune.example.com', 'x-csrf-token': '' });
    expect(verifyCsrf(request, { cookieToken: '' })).toBe(false);
  });
});
