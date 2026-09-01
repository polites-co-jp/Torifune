import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { redact, secretsOf } from '../redact.js';

/**
 * パスワードをコマンドラインから再設定する（`04_認証設計.md` §24）。
 *
 * 画面からのリセットはメールでトークンを配るため、メール送信を用意していない環境では
 * 使えない。**管理者が1人しかいない構成でその管理者が締め出されると、
 * 復旧する手段がまったく無くなる。** サーバーへ入れる者だけが実行できる経路として、
 * DB へ直接つないで差し替える。
 *
 * Torifune 本体（`apps/web`）は import しない。CLI は本体のビルド成果物に依存せず、
 * アプリが起動しない状態でも動かせる必要がある。
 * そのため、パスワードの規則とハッシュ方式は `authentication/password.ts` と
 * **同じものをここにも置いている**。片方だけ変えないこと。
 */

/** パスワードの長さ上限（バイト）。`authentication/password.ts` と揃える。 */
export const MAX_PASSWORD_BYTES = 1024;

export class UserNotFoundError extends Error {
  constructor(loginId: string) {
    // 無効化されたユーザーと存在しないユーザーを区別しない。
    // 区別すると、アカウントの存在を確かめる手段になる。
    super(`有効なユーザーが見つからない: ${loginId}`);
    this.name = 'UserNotFoundError';
  }
}

export class InvalidPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasswordError';
  }
}

export interface ResetPasswordOptions {
  readonly databaseUrl: string;
  readonly loginId: string;
  readonly newPassword: string;
}

export interface ResetPasswordResult {
  readonly userId: string;
  /** DB に登録されている表記のログインID（入力の大文字小文字とは限らない）。 */
  readonly loginId: string;
  readonly revokedSessions: number;
}

function assertUsablePassword(password: string): void {
  if (password.trim() === '') {
    throw new InvalidPasswordError('パスワードが空である');
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new InvalidPasswordError(`パスワードが長すぎる（上限 ${MAX_PASSWORD_BYTES} バイト）`);
  }
}

interface UserRow extends pg.QueryResultRow {
  id: string;
  login_id: string;
}

export async function resetPassword(options: ResetPasswordOptions): Promise<ResetPasswordResult> {
  const { databaseUrl, loginId, newPassword } = options;
  const secrets = secretsOf(databaseUrl);

  // 接続前に検証する。長大な入力をハッシュ計算に通す前に落とす。
  assertUsablePassword(newPassword);

  // ハッシュ計算はトランザクションの外で済ませる。
  // Argon2id は意図的に遅いので、その間 users の行を掴んだままにしない。
  const passwordHash = await hash(newPassword);

  const client = new pg.Client({ connectionString: databaseUrl });

  try {
    await client.connect();
  } catch (error) {
    throw redact(error, secrets);
  }

  try {
    await client.query('BEGIN');

    // 一意索引が lower(login_id) のため、照合もそれに合わせる。
    // 無効化されたユーザーは対象にしない。パスワードを変えられると、
    // 無効化したはずのアカウントを復活させる裏口になる。
    const { rows } = await client.query<UserRow>(
      `SELECT id, login_id FROM users
       WHERE lower(login_id) = lower($1) AND status = 'active'
       FOR UPDATE`,
      [loginId],
    );

    const user = rows[0];
    if (user === undefined) {
      await client.query('ROLLBACK');
      throw new UserNotFoundError(loginId);
    }

    await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
      passwordHash,
      user.id,
    ]);

    // パスワードを変えた以上、既存のセッションは信用できない。
    // 乗っ取られていた場合、ここで追い出せなければ再設定の意味がない。
    const revoked = await client.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    );

    await client.query(
      `INSERT INTO auth_audit_logs (id, event, user_id, detail)
       VALUES ($1, 'password.changed', $2, $3)`,
      // detail にパスワードを入れてはならない（04_認証設計.md §26）。
      // 画面からの変更と区別できるよう、経路だけを残す。
      [randomUUID(), user.id, JSON.stringify({ via: 'cli' })],
    );

    await client.query('COMMIT');

    return {
      userId: user.id,
      loginId: user.login_id,
      revokedSessions: revoked.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof UserNotFoundError || error instanceof InvalidPasswordError) {
      throw error;
    }
    throw redact(error, secrets);
  } finally {
    await client.end().catch(() => undefined);
  }
}
