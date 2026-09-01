import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import type { Notification } from '@/application/notification';
import { AppUrlNotConfiguredError } from './message';
import { createSmtpNotifier, readSmtpConfig, type SmtpConfig } from './smtp-notifier';

/**
 * SMTP 通知（019-notification 設計 §3.1、§3.3）。
 *
 * 実際の送信は行わず、Transporter を差し替えて渡した内容を検査する。
 * ネットワークに触るテストは、落ちたときに何が悪いのか分からなくなる。
 */

interface SentMail {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  text?: unknown;
}

function fakeTransport(): { transporter: Transporter; sent: SentMail[] } {
  const sent: SentMail[] = [];
  const transporter = {
    sendMail: vi.fn(async (mail: SentMail) => {
      sent.push(mail);
      return {};
    }),
  } as unknown as Transporter;
  return { transporter, sent };
}

const CONFIG: SmtpConfig = {
  url: 'smtps://user:pass@smtp.example.com:465',
  from: 'Torifune <no-reply@example.com>',
  appUrl: 'https://torifune.example.com',
};

const NOTIFICATION: Notification = {
  to: 'user@example.com',
  kind: 'password_reset',
  data: {},
  secret: 'tok-123',
};

describe('readSmtpConfig', () => {
  it('SMTP が設定されていなければ null', () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(readSmtpConfig({ TORIFUNE_SMTP_URL: '   ' })).toBeNull();
  });

  it('設定を読む', () => {
    const config = readSmtpConfig({
      TORIFUNE_SMTP_URL: 'smtp://localhost:1025',
      TORIFUNE_MAIL_FROM: 'a@example.com',
      APP_URL: 'https://example.com',
    });

    expect(config?.url).toBe('smtp://localhost:1025');
    expect(config?.from).toBe('a@example.com');
    expect(config?.appUrl).toBe('https://example.com');
  });

  it('差出人が無ければ既定を使う', () => {
    // 差出人が無いと多くの SMTP サーバーが受け付けない。
    expect(readSmtpConfig({ TORIFUNE_SMTP_URL: 'smtp://localhost' })?.from).not.toBe('');
  });
});

describe('createSmtpNotifier', () => {
  it('宛先・差出人・件名・本文を渡して送る', async () => {
    const { transporter, sent } = fakeTransport();
    await createSmtpNotifier(CONFIG, transporter).send(NOTIFICATION);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('user@example.com');
    expect(sent[0]?.from).toBe('Torifune <no-reply@example.com>');
    expect(String(sent[0]?.subject)).not.toBe('');
    expect(String(sent[0]?.text)).toContain(
      'https://torifune.example.com/password-reset/confirm?token=tok-123',
    );
  });

  /**
   * 設定の誤りで、攻撃者のサーバーを指すURLを送るより送らないほうがよい
   * （設計 §3.3）。
   */
  it('アプリのURLが未設定なら送らずに失敗する', async () => {
    const { transporter, sent } = fakeTransport();
    const notifier = createSmtpNotifier({ ...CONFIG, appUrl: undefined }, transporter);

    await expect(notifier.send(NOTIFICATION)).rejects.toThrow(AppUrlNotConfiguredError);
    expect(sent).toHaveLength(0);
  });

  it('トークンが無ければ送らずに失敗する', async () => {
    const { transporter, sent } = fakeTransport();
    const notifier = createSmtpNotifier(CONFIG, transporter);

    await expect(
      notifier.send({ to: 'user@example.com', kind: 'password_reset', data: {} }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  /** ログの閲覧権限が、そのままアカウント乗っ取りの権限になってはならない。 */
  it('トークンをログへ出さない', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line) => lines.push(String(line)));
    const error = vi.spyOn(console, 'error').mockImplementation((line) => lines.push(String(line)));

    const { transporter } = fakeTransport();
    await createSmtpNotifier(CONFIG, transporter).send(NOTIFICATION);

    expect(lines.join('\n')).not.toContain('tok-123');

    warn.mockRestore();
    error.mockRestore();
  });
});
