import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../../authentication/password';
import { authAuditRepository } from '../../infrastructure/auth-audit-repository';
import { userRepository } from '../../infrastructure/user-repository';
import { isValidEmail, isValidLoginId } from '../../domain/user';
import { withConnection, withTransaction } from '../transaction';
import type { RequestInfo } from './context';

/**
 * 初回セットアップ UseCase（決定事項 D-10）。
 *
 * 管理者が1人もいない間だけ、最初の管理者を作れる。
 * 環境変数にもイメージにも初期 Credential を置かずに済ませるための入口。
 */

export const ADMINISTRATOR_ROLE = 'administrator';

/** セットアップが開いているか。 */
export async function isSetupOpen(): Promise<boolean> {
  return withConnection(async (connection) => {
    const count = await userRepository.countByRoleForUpdate(connection, ADMINISTRATOR_ROLE);
    return count === 0;
  });
}

export interface SetupInput {
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly request: RequestInfo;
}

export type SetupOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'closed' | 'invalid_input' | 'conflict' };

export async function completeSetup(input: SetupInput): Promise<SetupOutcome> {
  if (!isValidLoginId(input.loginId)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!isValidEmail(input.email)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.displayName.trim() === '') {
    return { ok: false, reason: 'invalid_input' };
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.password);
  } catch {
    return { ok: false, reason: 'invalid_input' };
  }

  return withTransaction(async (tx) => {
    // 「0人であることの確認」と「作成」を同じトランザクションで行い、
    // roles の行ロックで直列化する。確認と作成が別トランザクションだと、
    // 同時に叩かれたとき管理者が2人できる。
    const existing = await userRepository.countByRoleForUpdate(tx, ADMINISTRATOR_ROLE);
    if (existing > 0) {
      return { ok: false, reason: 'closed' };
    }

    const userId = uuidv7();
    try {
      await userRepository.insert(tx, {
        id: userId,
        loginId: input.loginId,
        email: input.email,
        displayName: input.displayName,
        passwordHash,
      });
    } catch {
      // login_id / email の一意制約違反。
      return { ok: false, reason: 'conflict' };
    }

    await userRepository.assignRole(tx, userId, ADMINISTRATOR_ROLE);

    await authAuditRepository.record(tx, {
      id: uuidv7(),
      event: 'setup.completed',
      userId,
      loginIdAttempted: null,
      ipAddress: input.request.ipAddress,
      userAgent: input.request.userAgent,
      detail: {},
    });

    return { ok: true, userId };
  });
}
