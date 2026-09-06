import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAccessLogExcluded,
  primeAccessLogIpExclusions,
  resetAccessLogIpExclusionsForTests,
  resolveAccessLogIpExclusions,
} from '@/application/analytics/ip-exclusion';
import { SYSTEM_SETTING_KEYS } from '@/domain/system-settings';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';

/**
 * 除外IPの参照とキャッシュ（033-analytics-ip-exclusion 設計 §6、受け入れ条件 #47〜#53）。
 *
 * **DB は外部境界として差し替える。** ここで見たいのは
 * 「いつ読むか」「読めなかったときどう振る舞うか」であって、SQL ではない。
 */

const store = vi.hoisted(() => ({
  /** `loadAll` が返す値。 */
  value: [] as unknown,
  /** `loadAll` が呼ばれた回数。**読みに行ったかどうか**を数える。 */
  calls: 0,
  /** 次の `loadAll` で投げる例外。 */
  failure: null as Error | null,
}));

vi.mock('@/application/transaction', () => ({
  withConnection: async <T>(fn: (connection: unknown) => Promise<T>): Promise<T> => fn({}),
}));

vi.mock('@/infrastructure/system-settings-repository', () => ({
  systemSettingsRepository: {
    loadAll: async (): Promise<Map<string, unknown>> => {
      store.calls += 1;
      if (store.failure !== null) {
        throw store.failure;
      }
      return new Map<string, unknown>([[SYSTEM_SETTING_KEYS.accessLogExcludedIps, store.value]]);
    },
  },
}));

beforeEach(() => {
  store.value = [];
  store.calls = 0;
  store.failure = null;
  resetAccessLogIpExclusionsForTests();
});

afterEach(() => {
  resetAccessLogIpExclusionsForTests();
  resetLogger();
});

describe('isAccessLogExcluded', () => {
  /**
   * #47。**IP が分からないものを落とさない。**
   * 落とすと、Proxy の設定ミスで計測が全損する（設計 §6.4）。
   */
  it('IP が null なら除外しない', async () => {
    store.value = ['0.0.0.0/0'];
    await expect(isAccessLogExcluded(null)).resolves.toBe(false);
  });

  it('IP が null のときは設定を読みにも行かない', async () => {
    await isAccessLogExcluded(null);
    expect(store.calls).toBe(0);
  });

  /** #48 */
  it('IP が空文字なら除外しない', async () => {
    store.value = ['0.0.0.0/0'];
    await expect(isAccessLogExcluded('')).resolves.toBe(false);
    await expect(isAccessLogExcluded('   ')).resolves.toBe(false);
  });

  /** #49 */
  it('読めない IP は除外しない', async () => {
    store.value = ['0.0.0.0/0'];
    await expect(isAccessLogExcluded('not-an-ip')).resolves.toBe(false);
  });

  /** #50 */
  it('保存済みのリストに一致すれば除外する', async () => {
    store.value = ['203.0.113.10', '198.51.100.0/24'];

    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(true);
    await expect(isAccessLogExcluded('198.51.100.77')).resolves.toBe(true);
    await expect(isAccessLogExcluded('203.0.113.11')).resolves.toBe(false);
  });

  it('ポート付き・IPv4 射影でも判定できる', async () => {
    store.value = ['203.0.113.0/24'];

    await expect(isAccessLogExcluded('203.0.113.10:51234')).resolves.toBe(true);
    await expect(isAccessLogExcluded('::ffff:203.0.113.10')).resolves.toBe(true);
  });

  it('設定が空なら何も除外しない', async () => {
    store.value = [];
    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(false);
  });

  /**
   * 設計 §6.2。**古ければ待って読み直す**（タイムゾーンと違う点）。
   * 起動直後に待たないと、プロセスが立ち上がるたびに最初の数件が必ず記録される。
   */
  it('キャッシュが未読み込みなら読み終わってから判定する', async () => {
    store.value = ['203.0.113.10'];

    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(true);
    expect(store.calls).toBe(1);
  });

  it('TTL の内側では読み直さない', async () => {
    store.value = ['203.0.113.10'];

    await isAccessLogExcluded('203.0.113.10');
    await isAccessLogExcluded('203.0.113.11');
    await isAccessLogExcluded('198.51.100.1');

    expect(store.calls).toBe(1);
  });
});

describe('primeAccessLogIpExclusions', () => {
  /** #51。保存した直後に、そのプロセスへ即座に反映する。 */
  it('呼んだ直後は DB を読まずにその値で判定する', async () => {
    primeAccessLogIpExclusions(['198.51.100.0/24']);

    await expect(isAccessLogExcluded('198.51.100.5')).resolves.toBe(true);
    expect(store.calls).toBe(0);
  });

  it('渡した値は正規化される', async () => {
    primeAccessLogIpExclusions(['198.51.100.5/24']);

    await expect(resolveAccessLogIpExclusions()).resolves.toEqual([
      expect.objectContaining({ text: '198.51.100.0/24' }),
    ]);
  });

  it('空を渡すと何も除外しなくなる', async () => {
    primeAccessLogIpExclusions(['198.51.100.0/24']);
    primeAccessLogIpExclusions([]);

    await expect(isAccessLogExcluded('198.51.100.5')).resolves.toBe(false);
  });
});

/**
 * #52。**記録する側へ倒す（fail-open）**（設計 §6.3）。
 *
 * 逆にすると、DB の不調がそのまま計測の全損になり、後から復元できない。
 * 記録しすぎは数値の誤差だが、記録しないことは欠損である。
 */
describe('読み直しに失敗したとき', () => {
  it('例外を投げず、除外しない', async () => {
    store.failure = new Error('接続できない');

    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(false);
  });

  it('直前に読めていた値で続行する', async () => {
    store.value = ['203.0.113.10'];
    await isAccessLogExcluded('203.0.113.10');

    // TTL を跨がせて、読み直しが起きる状態にする。
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    store.failure = new Error('接続できない');

    try {
      await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(true);
      expect(store.calls).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('警告を残す', async () => {
    const records: LogRecord[] = [];
    setLogger({
      log(level, message, fields) {
        records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
      },
    });
    store.failure = new Error('接続できない');

    await isAccessLogExcluded('203.0.113.10');

    expect(records.some((record) => record.level === 'warn')).toBe(true);
  });
});

/** #53 */
describe('resetAccessLogIpExclusionsForTests', () => {
  it('未読み込みの状態へ戻す', async () => {
    store.value = ['203.0.113.10'];
    await isAccessLogExcluded('203.0.113.10');
    expect(store.calls).toBe(1);

    resetAccessLogIpExclusionsForTests();
    await isAccessLogExcluded('203.0.113.10');

    expect(store.calls).toBe(2);
  });
});
