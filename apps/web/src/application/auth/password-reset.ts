import { uuidv7 } from 'uuidv7';
import { RESET_TOKEN_LIFETIME_MS } from '../../domain/password-reset';
import { hashPassword } from '../../authentication/password';
import { generateSessionToken, hashSessionToken } from '../../authentication/session-token';
import { authAuditRepository } from '../../infrastructure/auth-audit-repository';
import { passwordResetRepository } from '../../infrastructure/password-reset-repository';
import { sessionRepository } from '../../infrastructure/session-repository';
import { userRepository } from '../../infrastructure/user-repository';
import { getNotifier } from '../notification';
import { withTransaction } from '../transaction';
import type { RequestInfo } from './context';

// 有効期限は Domain 層にある。リセットURLを作る Infrastructure 側も同じ値を要るため。
export { RESET_TOKEN_LIFETIME_MS };

export interface RequestResetInput {
  readonly email: string;
  readonly request: RequestInfo;
}

/**
 * パスワードリセットを要求する。
 *
 * **登録済みかどうかにかかわらず、常に同じ結果を返す。**
 * 存在するアドレスだけ成功を返すと、登録の有無を調べられる（04_認証設計.md §24）。
 */
export async function requestPasswordReset(input: RequestResetInput): Promise<void> {
  const token = generateSessionToken();

  const sent = await withTransaction(async (tx) => {
    const user = await userRepository.findByEmail(tx, input.email);
    if (user === null || user.status !== 'active') {
      return null;
    }

    await passwordResetRepository.insert(tx, {
      id: uuidv7(),
      userId: user.id,
      // 平文で保存しない。DB が漏れてもリセットできないようにする。
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_LIFETIME_MS),
    });

    await authAuditRepository.record(tx, {
      id: uuidv7(),
      event: 'password.reset.requested',
      userId: user.id,
      loginIdAttempted: null,
      ipAddress: input.request.ipAddress,
      userAgent: input.request.userAgent,
      detail: {},
    });

    return user.email;
  });

  if (sent !== null) {
    await getNotifier().send({
      to: sent,
      kind: 'password_reset',
      data: {},
      secret: token,
    });
  }
}

export interface ConfirmResetInput {
  readonly token: string;
  readonly newPassword: string;
  readonly request: RequestInfo;
}

export type ConfirmResetOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid_token' | 'invalid_password' };

export async function confirmPasswordReset(input: ConfirmResetInput): Promise<ConfirmResetOutcome> {
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.newPassword);
  } catch {
    return { ok: false, reason: 'invalid_password' };
  }

  return withTransaction(async (tx) => {
    const now = new Date();
    const record = await passwordResetRepository.findByTokenHash(tx, hashSessionToken(input.token));

    if (record === null || record.usedAt !== null || record.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'invalid_token' };
    }

    await userRepository.updatePasswordHash(tx, record.userId, passwordHash);
    await passwordResetRepository.markUsed(tx, record.id, now);

    // パスワードを変えた以上、既存のセッションは信用できない。
    // 乗っ取られていた場合、ここで追い出せなければリセットの意味がない。
    await sessionRepository.revokeAllForUser(tx, record.userId, now);

    await authAuditRepository.record(tx, {
      id: uuidv7(),
      event: 'password.reset.completed',
      userId: record.userId,
      loginIdAttempted: null,
      ipAddress: input.request.ipAddress,
      userAgent: input.request.userAgent,
      detail: {},
    });

    return { ok: true };
  });
}
