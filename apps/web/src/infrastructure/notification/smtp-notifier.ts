import { createTransport, type Transporter } from 'nodemailer';
import type { Notification, Notifier } from '@/application/notification';
import { log } from '@/infrastructure/logging';
import { buildPasswordResetMessage } from './message';

/**
 * SMTP で通知を送る（019-notification）。
 *
 * SMTP を自前で書かない。認証方式・TLS・エンコーディングなど、
 * 間違えると届かないか、最悪ヘッダインジェクションになる箇所が多い。
 */

export interface SmtpConfig {
  /** `smtps://user:pass@host:465` 形式。 */
  readonly url: string;
  /** 差出人。`Torifune <no-reply@example.com>` 形式も可。 */
  readonly from: string;
  /** リセットURLの基点。リクエストの Host からは組み立てない（設計 §3.3）。 */
  readonly appUrl: string | undefined;
}

/** 環境変数から設定を読む。SMTP が設定されていなければ null。 */
export function readSmtpConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SmtpConfig | null {
  const url = env['TORIFUNE_SMTP_URL'];
  if (url === undefined || url.trim() === '') {
    return null;
  }

  return {
    url: url.trim(),
    // 差出人が無いと多くの SMTP サーバーが受け付けない。既定を置く。
    from: env['TORIFUNE_MAIL_FROM']?.trim() ?? 'Torifune <no-reply@localhost>',
    // CSRF の同一オリジン判定と同じ APP_URL を使う。
    // メール用に別の変数を作ると、2つが食い違ったときに気づけない。
    appUrl: env['APP_URL'],
  };
}

export function createSmtpNotifier(
  config: SmtpConfig,
  transporter: Transporter = createTransport(config.url),
): Notifier {
  return {
    async send(notification: Notification): Promise<void> {
      if (notification.secret === undefined) {
        // トークンの無いリセット通知は送っても意味が無い。
        throw new Error('通知に必要な値が無い');
      }

      const message = buildPasswordResetMessage(config.appUrl, notification.secret);

      await transporter.sendMail({
        from: config.from,
        to: notification.to,
        subject: message.subject,
        text: message.text,
      });

      // **本文とトークンをログへ出さない。** 送ったという事実だけを残す。
      log.info('notification sent', { kind: notification.kind });
    },
  };
}
