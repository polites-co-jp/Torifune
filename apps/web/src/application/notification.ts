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
    console.warn(
      JSON.stringify({
        message: 'notification (not actually sent)',
        kind: notification.kind,
        to: notification.to,
        data: notification.data,
      }),
    );
  },
};

let notifier: Notifier = loggingNotifier;

export function getNotifier(): Notifier {
  return notifier;
}

export function setNotifier(next: Notifier): void {
  notifier = next;
}
