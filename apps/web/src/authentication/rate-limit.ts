import { uuidv7 } from 'uuidv7';
import type { Connection } from '../database/provider';
import type { LoginAttemptRepository } from '../domain/login-attempt-repository';

/**
 * ログイン試行制限（04_認証設計.md §25）。
 *
 * IP 単位とアカウント単位の両方で数える。
 * IP 側を緩くしているのは、NAT の内側から複数人が使う環境で巻き添えを避けるため。
 * **アカウント単位のほうを主な防御にする。**
 */

export interface RateLimitPolicy {
  readonly windowMs: number;
  readonly maxPerAccount: number;
  readonly maxPerIp: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  windowMs: 15 * 60 * 1000,
  maxPerAccount: 10,
  maxPerIp: 30,
};

export function accountKey(loginId: string): string {
  return `login:${loginId.toLowerCase()}`;
}

export function ipKey(ipAddress: string): string {
  return `ip:${ipAddress}`;
}

export interface RateLimiter {
  /** 試行してよいかを判定する。 */
  isAllowed(
    connection: Connection,
    input: { loginId: string; ipAddress: string | null; now: Date },
  ): Promise<boolean>;
  /** 失敗を記録する。 */
  recordFailure(
    connection: Connection,
    input: { loginId: string; ipAddress: string | null; now: Date },
  ): Promise<void>;
  /** 成功時に、そのアカウントの失敗記録を消す。 */
  clearAccount(connection: Connection, loginId: string): Promise<void>;
}

export function createRateLimiter(
  repository: LoginAttemptRepository,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT,
): RateLimiter {
  return {
    async isAllowed(connection, { loginId, ipAddress, now }): Promise<boolean> {
      const since = new Date(now.getTime() - policy.windowMs);

      const accountFailures = await repository.countSince(connection, accountKey(loginId), since);
      if (accountFailures >= policy.maxPerAccount) {
        return false;
      }

      if (ipAddress !== null) {
        const ipFailures = await repository.countSince(connection, ipKey(ipAddress), since);
        if (ipFailures >= policy.maxPerIp) {
          return false;
        }
      }

      return true;
    },

    async recordFailure(connection, { loginId, ipAddress, now }): Promise<void> {
      await repository.record(connection, uuidv7(), accountKey(loginId), now);
      if (ipAddress !== null) {
        await repository.record(connection, uuidv7(), ipKey(ipAddress), now);
      }
    },

    async clearAccount(connection, loginId): Promise<void> {
      // IP 側は消さない。1つのアカウントに成功しただけで、
      // 同じ IP からの他アカウントへの総当たりを許すことになる。
      await repository.clear(connection, accountKey(loginId));
    },
  };
}
