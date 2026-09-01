import { log } from '../infrastructure/logging';
import { createSmtpNotifier, readSmtpConfig } from '../infrastructure/notification/smtp-notifier';

/**
 * 通知の抽象。
 *
 * パスワードリセットの通知先を差し替えられるようにする。
 * 実メール送信は `019-notification` で実装する。
 */

export interface Notification {
  readonly to: string;
  readonly kind: 'password_reset';
  /** 通知に埋め込む値。**トークンをここへ入れてはならない。** */
  readonly data: Record<string, string>;
  /** 受け取り側だけが扱う機密値。ログへ出さない。 */
  readonly secret?: string | undefined;
}

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/**
 * 開発用の実装。ログへ出すだけ。
 *
 * **`secret` をログへ出さない。** リセットURLをログから拾えると、
 * ログの閲覧権限がそのままアカウント乗っ取りの権限になる。
 */
export const loggingNotifier: Notifier = {
  async send(notification: Notification): Promise<void> {
    log.warn('notification (not actually sent)', {
      kind: notification.kind,
      to: notification.to,
      data: notification.data,
    });
  },
};

let notifier: Notifier | null = null;

/**
 * 実際に使う通知手段を決める。
 *
 * **SMTP が設定されていなければ起動を失敗させない。** 自己ホスト型では
 * SMTP を用意しない運用が普通にあり、そこで起動できなくなるのは過剰。
 * 復旧手段は `torifune reset-password` にある。
 *
 * ただし黙って送らないのは不親切なので、一度だけ警告を出す。
 */
function resolveNotifier(): Notifier {
  const config = readSmtpConfig();
  if (config === null) {
    log.warn('SMTP is not configured; password reset mail will not be sent', {
      hint: 'TORIFUNE_SMTP_URL を設定するか、torifune reset-password で復旧する',
    });
    return loggingNotifier;
  }
  return createSmtpNotifier(config);
}

export function getNotifier(): Notifier {
  notifier ??= resolveNotifier();
  return notifier;
}

export function setNotifier(next: Notifier): void {
  notifier = next;
}

/** テスト用。次回の `getNotifier()` で環境変数から選び直す。 */
export function resetNotifier(): void {
  notifier = null;
}
