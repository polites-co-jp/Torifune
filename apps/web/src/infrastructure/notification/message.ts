import { RESET_TOKEN_LIFETIME_HOURS } from '@/domain/password-reset';

/**
 * パスワードリセットの通知本文（019-notification 設計 §3.3、§5）。
 */

export class AppUrlNotConfiguredError extends Error {
  constructor() {
    super(
      'APP_URL が設定されていない。' +
        'リセットURLの組み立てに必要で、リクエストの Host からは組み立てない。',
    );
    this.name = 'AppUrlNotConfiguredError';
  }
}

/**
 * リセットURLを組み立てる。
 *
 * **リクエストの `Host` ヘッダから組み立てない。**
 * 攻撃者が `Host` を差し替えると、自分のサーバーを指すリセットURLを
 * メールで送れてしまう（Host header injection）。
 * 設定が無いなら、誤った宛先へ送るより送らないほうがよい。
 */
export function resetUrl(appUrl: string | undefined, token: string): string {
  if (appUrl === undefined || appUrl.trim() === '') {
    throw new AppUrlNotConfiguredError();
  }

  let base: URL;
  try {
    base = new URL(appUrl.trim());
  } catch {
    throw new AppUrlNotConfiguredError();
  }

  // javascript: や data: を通すと、メールのリンクがそのまま攻撃面になる。
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new AppUrlNotConfiguredError();
  }

  // サブパスに設置されている場合を壊さない。
  const path = base.pathname.replace(/\/$/, '');
  return `${base.origin}${path}/password-reset/confirm?token=${encodeURIComponent(token)}`;
}

export interface MailMessage {
  readonly subject: string;
  readonly text: string;
}

/**
 * 本文を組み立てる。
 *
 * **宛名を入れない。** 名前を入れると、そのアドレスの持ち主が誰かを
 * メール本文で確認できてしまう（アカウント列挙の材料になる）。
 */
export function buildPasswordResetMessage(appUrl: string | undefined, token: string): MailMessage {
  const url = resetUrl(appUrl, token);

  return {
    subject: '[Torifune] パスワードの再設定',
    text: [
      'パスワードの再設定が要求されました。',
      '',
      '次のリンクを開いて、新しいパスワードを設定してください。',
      '',
      url,
      '',
      `このリンクは${RESET_TOKEN_LIFETIME_HOURS}時間で使えなくなります。また、一度使うと無効になります。`,
      '',
      '心当たりが無い場合は、このメールを破棄してください。',
      'リンクを開かないかぎり、パスワードは変わりません。',
    ].join('\n'),
  };
}
