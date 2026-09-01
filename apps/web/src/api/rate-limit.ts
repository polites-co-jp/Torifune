/**
 * 汎用の Rate Limit（05_API設計.md §36）。
 *
 * **インメモリにしている理由**：一般 API の制限は記録として残す価値が無く、
 * DB への書き込みがかえって負荷になる。
 * ログイン試行制限（`authentication/rate-limit.ts`）は攻撃の記録として
 * 意味があるため DB に置いており、そちらとは目的が違う。
 *
 * 単一プロセス前提。複数インスタンスで厳密に効かせたくなったら、
 * この `RateLimiter` インターフェースのまま共有ストア実装へ差し替える。
 */

export interface RateLimitPolicy {
  readonly windowMs: number;
  readonly max: number;
}

/**
 * 既定の Rate Limit。`defineRoute` が省略時にかける。
 *
 * **まともな利用では当たらないが、総当たりと大量取得は止まる**水準にする。
 * 厳しくすると正規の利用者を締め出し、緩めると意味が無い。
 * 認証系はこれより厳しい値をルート側で上書きしている。
 */
export const DEFAULT_RATE_LIMIT: RateLimitPolicy = { windowMs: 60_000, max: 300 };

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** 429 のとき、何秒後に再試行してよいか。 */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, now: number): RateLimitVerdict;
  reset(): void;
}

/** メモリを際限なく使わないための上限。超えたら古いものから落とす。 */
const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(policy: RateLimitPolicy): RateLimiter {
  const hits = new Map<string, number[]>();

  function sweep(now: number): void {
    const threshold = now - policy.windowMs;
    for (const [key, timestamps] of hits) {
      const alive = timestamps.filter((t) => t > threshold);
      if (alive.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, alive);
      }
    }
  }

  return {
    check(key: string, now: number): RateLimitVerdict {
      // 掃除を忘れると際限なくメモリを食う。アクセスのついでに落とす。
      sweep(now);

      if (hits.size >= MAX_TRACKED_KEYS && !hits.has(key)) {
        // 追跡しきれない量のキーが来ている。新しいキーは通す
        // （拒否すると、キーを大量生成するだけで正規の利用者を締め出せてしまう）。
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const timestamps = hits.get(key) ?? [];

      if (timestamps.length >= policy.max) {
        const oldest = timestamps[0] ?? now;
        const retryAfterMs = Math.max(0, oldest + policy.windowMs - now);
        return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
      }

      timestamps.push(now);
      hits.set(key, timestamps);
      return { allowed: true, retryAfterSeconds: 0 };
    },

    reset(): void {
      hits.clear();
    },
  };
}
