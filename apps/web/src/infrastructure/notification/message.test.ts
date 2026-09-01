import { describe, expect, it } from 'vitest';
import { AppUrlNotConfiguredError, buildPasswordResetMessage, resetUrl } from './message';

/**
 * リセットメールの本文（019-notification 設計 §3.3、§5）。
 */

describe('resetUrl', () => {
  it('アプリのURLを基点に組み立てる', () => {
    expect(resetUrl('https://torifune.example.com', 'abc123')).toBe(
      'https://torifune.example.com/password-reset/confirm?token=abc123',
    );
  });

  it('末尾のスラッシュがあっても二重にしない', () => {
    expect(resetUrl('https://torifune.example.com/', 'abc123')).toBe(
      'https://torifune.example.com/password-reset/confirm?token=abc123',
    );
  });

  it('サブパスに設置していても保つ', () => {
    expect(resetUrl('https://example.com/torifune', 'abc123')).toBe(
      'https://example.com/torifune/password-reset/confirm?token=abc123',
    );
  });

  it('トークンをURLエンコードする', () => {
    expect(resetUrl('https://example.com', 'a+b/c=')).toContain('token=a%2Bb%2Fc%3D');
  });

  /**
   * リクエストの Host から組み立てない（設計 §3.3）。
   * 設定が無いなら、誤った宛先へ送るより送らないほうがよい。
   */
  it.each([undefined, '', '   '])('アプリのURLが無ければ失敗する: %s', (value) => {
    expect(() => resetUrl(value, 'abc123')).toThrow(AppUrlNotConfiguredError);
  });

  it('http/https 以外を拒否する', () => {
    expect(() => resetUrl('javascript:alert(1)', 'abc')).toThrow(AppUrlNotConfiguredError);
  });
});

describe('buildPasswordResetMessage', () => {
  const message = buildPasswordResetMessage('https://torifune.example.com', 'tok-123');

  it('リセットURLを本文に含む', () => {
    expect(message.text).toContain(
      'https://torifune.example.com/password-reset/confirm?token=tok-123',
    );
  });

  it('件名がある', () => {
    expect(message.subject.trim()).not.toBe('');
  });

  it('有効期限を伝える', () => {
    // いつまで使えるか分からないと、利用者は期限切れを不具合だと考える。
    expect(message.text).toContain('1時間');
  });

  it('心当たりが無い場合の案内を入れる', () => {
    expect(message.text).toContain('心当たり');
  });

  /**
   * 宛名を入れない（設計 §5）。
   * 入れると、アドレスの持ち主が誰かをメール本文で確認できてしまう。
   */
  it('宛先の氏名やログインIDを含めない', () => {
    const built = buildPasswordResetMessage('https://example.com', 'tok');
    expect(built.text).not.toMatch(/様|さん/);
  });
});
