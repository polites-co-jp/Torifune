import { describe, expect, it } from 'vitest';
import type { Connection } from '../database/provider';
import type { LoginAttemptRepository } from '../domain/login-attempt-repository';
import { accountKey, createRateLimiter, ipKey, type RateLimitPolicy } from './rate-limit';

/**
 * `002-authentication` の検証レポート F-2 で持ち越した項目（IP 単位・時間窓）を検証する。
 *
 * DB を使わないインメモリ実装にする。時間窓の経過を自由に作れるようにするため。
 */
function inMemoryRepository(): LoginAttemptRepository & { rows: { key: string; at: Date }[] } {
  const rows: { key: string; at: Date }[] = [];
  return {
    rows,
    async record(_connection, _id, key, at) {
      rows.push({ key, at });
    },
    async countSince(_connection, key, since) {
      return rows.filter((r) => r.key === key && r.at.getTime() >= since.getTime()).length;
    },
    async clear(_connection, key) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]?.key === key) {
          rows.splice(i, 1);
        }
      }
    },
  };
}

// Repository はこの Connection を使わないため、素通しのダミーで足りる。
const connection = {} as Connection;

const policy: RateLimitPolicy = {
  windowMs: 15 * 60 * 1000,
  maxPerAccount: 3,
  maxPerIp: 5,
};

const t0 = new Date('2026-08-24T00:00:00Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * 60 * 1000);

describe('アカウント単位の制限', () => {
  it('閾値未満なら許可する', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 2; i += 1) {
      await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(0) });
    }

    await expect(
      limiter.isAllowed(connection, { loginId: 'alice', ipAddress: null, now: at(0) }),
    ).resolves.toBe(true);
  });

  it('閾値に達したら拒否する', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 3; i += 1) {
      await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(0) });
    }

    await expect(
      limiter.isAllowed(connection, { loginId: 'alice', ipAddress: null, now: at(0) }),
    ).resolves.toBe(false);
  });

  it('別アカウントは巻き添えにならない', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 3; i += 1) {
      await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(0) });
    }

    await expect(
      limiter.isAllowed(connection, { loginId: 'bob', ipAddress: null, now: at(0) }),
    ).resolves.toBe(true);
  });

  it('大文字小文字を区別しない', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 3; i += 1) {
      await limiter.recordFailure(connection, { loginId: 'Alice', ipAddress: null, now: at(0) });
    }

    await expect(
      limiter.isAllowed(connection, { loginId: 'alice', ipAddress: null, now: at(0) }),
    ).resolves.toBe(false);
  });
});

describe('IP 単位の制限', () => {
  it('IP の閾値に達したら、別アカウントでも拒否する', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    // 5 つの別アカウントへ 1 回ずつ失敗する。アカウント単位では閾値未満。
    for (let i = 0; i < 5; i += 1) {
      await limiter.recordFailure(connection, {
        loginId: `user${i}`,
        ipAddress: '203.0.113.9',
        now: at(0),
      });
    }

    await expect(
      limiter.isAllowed(connection, {
        loginId: 'user99',
        ipAddress: '203.0.113.9',
        now: at(0),
      }),
    ).resolves.toBe(false);
  });

  it('別の IP は巻き添えにならない', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 5; i += 1) {
      await limiter.recordFailure(connection, {
        loginId: `user${i}`,
        ipAddress: '203.0.113.9',
        now: at(0),
      });
    }

    await expect(
      limiter.isAllowed(connection, {
        loginId: 'user99',
        ipAddress: '198.51.100.1',
        now: at(0),
      }),
    ).resolves.toBe(true);
  });

  it('IP が不明なら IP 単位の判定を行わない', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 10; i += 1) {
      await limiter.recordFailure(connection, {
        loginId: `user${i}`,
        ipAddress: '203.0.113.9',
        now: at(0),
      });
    }

    await expect(
      limiter.isAllowed(connection, { loginId: 'user99', ipAddress: null, now: at(0) }),
    ).resolves.toBe(true);
  });
});

describe('時間窓', () => {
  it('窓を過ぎた失敗は数えない', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 3; i += 1) {
      await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(0) });
    }

    // 15 分ちょうどでは、境界の扱いにより窓の外になる。
    await expect(
      limiter.isAllowed(connection, { loginId: 'alice', ipAddress: null, now: at(16) }),
    ).resolves.toBe(true);
  });

  it('窓の内側なら数える', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    for (let i = 0; i < 3; i += 1) {
      await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(0) });
    }

    await expect(
      limiter.isAllowed(connection, { loginId: 'alice', ipAddress: null, now: at(14) }),
    ).resolves.toBe(false);
  });

  it('窓が滑るので、古い失敗だけが落ちる', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(0) });
    await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(10) });
    await limiter.recordFailure(connection, { loginId: 'alice', ipAddress: null, now: at(20) });

    // at(20) の時点では 10 分前と 20 分前の 2 件が有効 → 閾値未満
    await expect(
      limiter.isAllowed(connection, { loginId: 'alice', ipAddress: null, now: at(20) }),
    ).resolves.toBe(true);
  });
});

describe('成功時の扱い', () => {
  it('アカウントの失敗記録を消す', async () => {
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    await limiter.recordFailure(connection, {
      loginId: 'alice',
      ipAddress: '203.0.113.9',
      now: at(0),
    });
    await limiter.clearAccount(connection, 'alice');

    expect(repository.rows.filter((r) => r.key === accountKey('alice'))).toHaveLength(0);
  });

  it('IP の失敗記録は消さない', async () => {
    // 1 アカウントに成功しただけで、同じ IP からの他アカウントへの
    // 総当たりを許すことになるため。
    const repository = inMemoryRepository();
    const limiter = createRateLimiter(repository, policy);

    await limiter.recordFailure(connection, {
      loginId: 'alice',
      ipAddress: '203.0.113.9',
      now: at(0),
    });
    await limiter.clearAccount(connection, 'alice');

    expect(repository.rows.filter((r) => r.key === ipKey('203.0.113.9'))).toHaveLength(1);
  });
});
