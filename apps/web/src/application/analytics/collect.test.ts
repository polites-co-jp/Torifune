import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectAccess,
  resetDailySalts,
  trackingScript,
  trackingScriptEtag,
} from '@/application/analytics/collect';
import {
  primeAccessLogIpExclusions,
  resetAccessLogIpExclusionsForTests,
} from '@/application/analytics/ip-exclusion';
import {
  resetAnalyticsTimeZoneForTests,
  resetTimeZoneWarning,
} from '@/application/analytics/timezone';
import { todayInTimeZone } from '@/domain/analytics/day';

/**
 * 計測の DB は外部境界として差し替える（ソルトの検証。ファイル末尾の describe）。
 *
 * `vi.mock` / `vi.hoisted` は巻き上げの対象なので位置に依らないが、
 * **このファイルが DB を持たない**ことが読んで分かるよう先頭に置く。
 */
const collected = vi.hoisted(() => ({
  entries: [] as { visitorHash: string }[],
  /** サイトを引きに行った回数。**除外された送信元には引かせない**（033 設計 §7）。 */
  siteLookups: 0,
}));

vi.mock('@/application/transaction', () => ({
  withConnection: async <T>(fn: (connection: unknown) => Promise<T>): Promise<T> => fn({}),
}));

/**
 * 除外IPの設定も DB から読む（033）。**このファイルは DB を持たない**ので、
 * 空を返す口として差し替える。除外の検証はファイル末尾の describe で
 * `primeAccessLogIpExclusions` から与える。
 */
vi.mock('@/infrastructure/system-settings-repository', () => ({
  systemSettingsRepository: {
    loadAll: async (): Promise<Map<string, unknown>> => new Map(),
  },
}));

vi.mock('@/infrastructure/analytics-repository', () => ({
  analyticsRepository: {
    findSiteByPublicKey: async () => {
      collected.siteLookups += 1;
      return { id: 'site-for-salt', status: 'active' };
    },
    recordAccess: async (_connection: unknown, entry: { visitorHash: string }) => {
      collected.entries.push(entry);
    },
  },
}));

/**
 * 計測スクリプト（018-analytics 設計 §3.4）。
 *
 * **他所のサイトへ貼られる。** 別オリジンから叩かれても
 * プリフライトが起きない形であることを、ここで固定する。
 *
 * **SPA のクライアント遷移でも送る。** ブラウザは無いので、`history` /
 * `location` / `document` / `navigator` を最小限に模した環境で
 * スクリプトそのものを実行し、送信の回数と中身を見る。
 */

const ORIGIN = 'https://torifune.example.com';
const COLLECT_URL = `${ORIGIN}/api/v1/collect`;

interface Beacon {
  readonly url: string;
  readonly type: string;
  readonly body: { key: string; path: string; referrer: string | null };
}

interface HistoryCall {
  readonly self: unknown;
  readonly args: unknown[];
}

interface FakeHistory {
  pushState(state: unknown, title: string, url: string): unknown;
  replaceState(state: unknown, title: string, url: string): unknown;
}

interface Browser {
  readonly history: FakeHistory;
  readonly beacons: Beacon[];
  readonly xhrs: { url: string; headers: Record<string, string>; body: string }[];
  readonly pushCalls: HistoryCall[];
  readonly pushStateResult: symbol;
  readonly touched: { cookie: boolean; localStorage: boolean };
  /** タグを1回実行する。2回呼べば「タグが2回貼られた」になる。 */
  run(): void;
  pushState(url: string): unknown;
  replaceState(url: string): unknown;
  /** 戻る／進む。URL を変えてから popstate を起こす。 */
  popTo(url: string): void;
  /** `<script data-site>` が読み終わった後の状態にする。 */
  detachCurrentScript(): void;
}

function fakeBrowser(options: {
  key?: string | null;
  pathname?: string;
  referrer?: string;
  sendBeacon?: boolean;
  beaconThrows?: boolean;
}): Browser {
  const beacons: Beacon[] = [];
  const xhrs: Browser['xhrs'] = [];
  const pushCalls: HistoryCall[] = [];
  const pushStateResult = Symbol('pushState result');
  const touched = { cookie: false, localStorage: false };
  const listeners = new Map<string, (() => void)[]>();
  const location = { pathname: options.pathname ?? '/', hash: '' };

  const applyUrl = (url: string): void => {
    const parsed = new URL(url, 'https://spa.example.com');
    location.pathname = parsed.pathname;
    location.hash = parsed.hash;
  };

  // 元の pushState。呼ばれ方を記録し、判別できる値を返す。
  const history: FakeHistory = {
    pushState(this: unknown, ...args: [unknown, string, string]) {
      pushCalls.push({ self: this, args });
      applyUrl(args[2]);
      return pushStateResult;
    },
    replaceState(this: unknown, ...args: [unknown, string, string]) {
      applyUrl(args[2]);
      return undefined;
    },
  };

  class FakeBlob {
    readonly text: string;
    readonly type: string;
    constructor(parts: string[], init: { type: string }) {
      this.text = parts.join('');
      this.type = init.type;
    }
  }

  class FakeXhr {
    private url = '';
    private readonly headers: Record<string, string> = {};
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: string) {
      xhrs.push({ url: this.url, headers: this.headers, body });
    }
  }

  const document = {
    currentScript:
      options.key === null
        ? null
        : {
            getAttribute: (name: string) =>
              name === 'data-site' ? (options.key ?? 'site-key') : null,
          },
    referrer: options.referrer ?? '',
    get cookie() {
      touched.cookie = true;
      return '';
    },
  };

  const navigator =
    options.sendBeacon === false
      ? {}
      : {
          sendBeacon(url: string, blob: FakeBlob) {
            if (options.beaconThrows) {
              throw new Error('beacon failed');
            }
            beacons.push({ url, type: blob.type, body: JSON.parse(blob.text) });
            return true;
          },
        };

  const sandbox: Record<string, unknown> = {
    document,
    history,
    location,
    navigator,
    Blob: FakeBlob,
    XMLHttpRequest: FakeXhr,
    addEventListener(name: string, listener: () => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
  };
  Object.defineProperty(sandbox, 'localStorage', {
    get() {
      touched.localStorage = true;
      return {};
    },
  });
  sandbox['window'] = sandbox;

  const dispatch = (name: string): void => {
    for (const listener of listeners.get(name) ?? []) {
      listener();
    }
  };

  return {
    history,
    beacons,
    xhrs,
    pushCalls,
    pushStateResult,
    touched,
    run: () => runInNewContext(trackingScript(ORIGIN), sandbox),
    pushState: (url) => history.pushState({}, '', url),
    replaceState: (url) => history.replaceState({}, '', url),
    popTo: (url) => {
      applyUrl(url);
      dispatch('popstate');
    },
    detachCurrentScript: () => {
      document.currentScript = null;
    },
  };
}

describe('trackingScript', () => {
  const script = trackingScript(ORIGIN);

  it('受け口の絶対URLを埋め込む', () => {
    // 貼られる側のオリジンでは相対パスが別のサーバーを指す。
    expect(script).toContain(COLLECT_URL);
  });

  it('プリフライトを起こす Content-Type を使わない', () => {
    // application/json は CORS セーフリスト外。別オリジンへ送ると
    // OPTIONS が飛び、TORIFUNE_CORS_ORIGINS に載っていないサイトの計測が
    // まるごと落ちる。text/plain はセーフリストなので単純リクエストになる。
    expect(script).not.toContain('application/json');
    expect(script).toContain('text/plain');
  });

  it('Cookie も localStorage も使わない', () => {
    // 使うと同意取得の話が乗ってきて、導入の敷居が上がる。
    expect(script).not.toContain('document.cookie');
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');

    const browser = fakeBrowser({});
    browser.run();
    browser.pushState('/about');
    expect(browser.touched).toEqual({ cookie: false, localStorage: false });
  });

  it('全ページから読まれるので小さく保つ', () => {
    expect(Buffer.byteLength(script, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('オリジンごとに ETag が変わる', () => {
    expect(trackingScriptEtag('https://a.example.com')).not.toBe(
      trackingScriptEtag('https://b.example.com'),
    );
  });

  describe('ハードロード', () => {
    it('ロード時に1件送る。referrer は document.referrer', () => {
      const browser = fakeBrowser({
        key: 'c3b9',
        pathname: '/topics/18665',
        referrer: 'https://www.google.com/',
      });
      browser.run();

      expect(browser.beacons).toEqual([
        {
          url: COLLECT_URL,
          type: 'text/plain;charset=UTF-8',
          body: { key: 'c3b9', path: '/topics/18665', referrer: 'https://www.google.com/' },
        },
      ]);
    });

    it('流入元が無ければ referrer は null', () => {
      const browser = fakeBrowser({ referrer: '' });
      browser.run();

      expect(browser.beacons[0]?.body.referrer).toBeNull();
    });

    it('data-site が無ければ何もしない', () => {
      const browser = fakeBrowser({ key: null });
      browser.run();
      browser.pushState('/about');

      expect(browser.beacons).toEqual([]);
      expect(browser.xhrs).toEqual([]);
    });

    it('sendBeacon が無いブラウザでは XHR で text/plain のまま送る', () => {
      const browser = fakeBrowser({ sendBeacon: false, pathname: '/x' });
      browser.run();

      expect(browser.xhrs).toEqual([
        {
          url: COLLECT_URL,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ key: 'site-key', path: '/x', referrer: null }),
        },
      ]);
    });
  });

  describe('SPA のクライアント遷移', () => {
    it('pushState で pathname が変わるたびに1件送る', () => {
      const browser = fakeBrowser({ pathname: '/' });
      browser.run();
      browser.pushState('/topics');
      browser.pushState('/topics/18665');

      expect(browser.beacons.map((beacon) => beacon.body.path)).toEqual([
        '/',
        '/topics',
        '/topics/18665',
      ]);
    });

    it('popstate（戻る／進む）でも送る', () => {
      const browser = fakeBrowser({ pathname: '/' });
      browser.run();
      browser.pushState('/about');
      browser.popTo('/');

      expect(browser.beacons.map((beacon) => beacon.body.path)).toEqual(['/', '/about', '/']);
    });

    it('遷移時の referrer は null で送る', () => {
      // document.referrer は SPA の間ずっと外部流入元のまま。遷移ごとに送ると
      // 流入元が実数以上に膨らむ。自サイトを送っても自己参照ノイズになる。
      const browser = fakeBrowser({ pathname: '/', referrer: 'https://www.google.com/' });
      browser.run();
      browser.pushState('/about');
      browser.popTo('/');

      expect(browser.beacons.map((beacon) => beacon.body.referrer)).toEqual([
        'https://www.google.com/',
        null,
        null,
      ]);
    });

    it('公開キーは初回に閉じ込める。currentScript が消えても送れる', () => {
      // 後続のコールバック内では document.currentScript が null になる。
      const browser = fakeBrowser({ key: 'c3b9', pathname: '/' });
      browser.run();
      browser.detachCurrentScript();
      browser.pushState('/about');

      expect(browser.beacons[1]?.body.key).toBe('c3b9');
    });

    it('同じ pathname への replaceState / pushState の連発では増えない', () => {
      // Next.js はスクロール復元やクエリ更新で replaceState を連発する。
      // 受け口は query を捨てて path だけを保存するので、判定も pathname で行う。
      const browser = fakeBrowser({ pathname: '/topics' });
      browser.run();
      browser.replaceState('/topics?page=2');
      browser.replaceState('/topics?page=3');
      browser.pushState('/topics');
      browser.pushState('/topics#section');
      browser.popTo('/topics');

      expect(browser.beacons).toHaveLength(1);
    });

    it('ハードロード直後に同じ pathname へ replaceState されても増えない', () => {
      const browser = fakeBrowser({ pathname: '/' });
      browser.run();
      browser.replaceState('/?utm_source=x');

      expect(browser.beacons).toHaveLength(1);
    });
  });

  describe('ホストサイトを壊さない', () => {
    it('pushState の戻り値・this・引数をそのまま通す', () => {
      const browser = fakeBrowser({ pathname: '/' });
      browser.run();

      const state = { from: 'test' };
      const result = browser.history.pushState(state, '', '/about');

      expect(result).toBe(browser.pushStateResult);
      expect(browser.pushCalls).toHaveLength(1);
      expect(browser.pushCalls[0]?.self).toBe(browser.history);
      expect(browser.pushCalls[0]?.args).toEqual([state, '', '/about']);
      expect(browser.pushCalls[0]?.args[0]).toBe(state);
    });

    it('送信が失敗しても pushState は完了し、例外が漏れない', () => {
      const browser = fakeBrowser({ pathname: '/', beaconThrows: true });
      browser.run();

      expect(() => browser.pushState('/about')).not.toThrow();
      expect(browser.pushCalls).toHaveLength(1);
      expect(browser.pushState('/contact')).toBe(browser.pushStateResult);
    });

    it('タグが2回貼られても二重に入らない', () => {
      const browser = fakeBrowser({ pathname: '/' });
      browser.run();
      browser.run();
      browser.pushState('/about');

      // ロード1件 + 遷移1件。2回目のタグは送らず、pushState も二重に包まない。
      expect(browser.beacons.map((beacon) => beacon.body.path)).toEqual(['/', '/about']);
      expect(browser.pushCalls).toHaveLength(1);
    });
  });
});

/**
 * ソルトの境目（032-timezone-setting 設計 §6.3、受け入れ条件 #26〜#28）。
 *
 * `saltDay(now)` が返す日付キーが変わると `salts` が miss し、
 * **その場で `clear()` して新しいソルトを作る。** 基準タイムゾーンを変えた瞬間に
 * これが起きるため、変更した当日の訪問者数は実際より多く出る（直せない。§6.3）。
 *
 * ソルトは `collect.ts` の外へ出していないので、**`collectAccess` の書き込みから見る。**
 * DB は外部境界として差し替える（同じ入力・同じサイトで、変わるのはソルトだけになる）。
 *
 * **時刻は動かさない。** 代わりに、オフセットが 25 時間離れた 2 つのタイムゾーン
 * （`Pacific/Kiritimati` = +14 と `Pacific/Midway` = −11）を使う。
 * どの瞬間でも日付が必ず 1 日ずれるので、実行時刻に依存しない。
 * 日付が変わらない場合は、オフセットが同じ 2 つ（`UTC` と `Atlantic/Reykjavik`）を使う。
 */

/** 東（+14）。 */
const EAST = 'Pacific/Kiritimati';
/** 西（−11）。EAST とは 25 時間離れているので、日付が必ず 1 日ずれる。 */
const WEST = 'Pacific/Midway';
/** UTC と同じオフセットで夏時間を持たない。日付が必ず一致する。 */
const SAME_AS_UTC = 'Atlantic/Reykjavik';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** そのタイムゾーンを効かせて 1 件記録し、`visitor_hash` を返す。 */
async function hashUnder(timeZone: string): Promise<string> {
  process.env['TORIFUNE_TIMEZONE'] = timeZone;
  resetAnalyticsTimeZoneForTests();
  collected.entries.length = 0;

  const outcome = await collectAccess({
    publicKey: 'public-key',
    path: '/',
    referrer: null,
    ipAddress: '203.0.113.10',
    userAgent: UA,
  });

  expect(outcome.ok, '計測が失敗した').toBe(true);
  const entry = collected.entries[0];
  expect(entry, '記録されていない').toBeDefined();
  return entry?.visitorHash ?? '';
}

describe('ソルトの境目（基準タイムゾーンの変更）', () => {
  afterEach(() => {
    delete process.env['TORIFUNE_TIMEZONE'];
    resetTimeZoneWarning();
    resetAnalyticsTimeZoneForTests();
    resetDailySalts();
    collected.entries.length = 0;
  });

  /** #26。日付キーが変わればソルトが回る。 */
  it('日付キーが未来へ変わると、同じ入力でも visitorHash が変わる', async () => {
    const now = new Date();
    expect(todayInTimeZone(EAST, now) > todayInTimeZone(WEST, now), '前提: 東のほうが後の日').toBe(
      true,
    );

    const before = await hashUnder(WEST);
    const after = await hashUnder(EAST);

    expect(after).not.toBe(before);
  });

  /**
   * #27。境界値。日付キーが変わらないときは回らない。
   *
   * ここで変わってしまうと、タイムゾーンを変えるたびに訪問者数が無意味に増える。
   */
  it('日付キーが変わらなければ visitorHash も変わらない', async () => {
    const now = new Date();
    expect(todayInTimeZone('UTC', now), '前提: 同じ日付').toBe(todayInTimeZone(SAME_AS_UTC, now));

    const before = await hashUnder('UTC');
    const after = await hashUnder(SAME_AS_UTC);

    expect(after).toBe(before);
  });

  /**
   * #28。境界値。**過去へ**動いたときも新しいソルトが作られる。
   *
   * `salts` は「見つからなければ全部捨てて作り直す」ので、
   * 未来向き（miss）と同じ経路を通る。西向きの変更を取りこぼさない。
   */
  it('日付キーが過去へ変わったときも visitorHash が変わる', async () => {
    const now = new Date();
    expect(todayInTimeZone(WEST, now) < todayInTimeZone(EAST, now), '前提: 西のほうが前の日').toBe(
      true,
    );

    const before = await hashUnder(EAST);
    const after = await hashUnder(WEST);

    expect(after).not.toBe(before);
  });

  /** #28 の裏。同じタイムゾーンで 2 回続けて記録すればソルトは回らない（検査が空振りしていない）。 */
  it('同じタイムゾーンのままなら visitorHash は変わらない', async () => {
    const first = await hashUnder(EAST);
    const second = await hashUnder(EAST);

    expect(second).toBe(first);
  });
});

/**
 * 除外IP（033-analytics-ip-exclusion 設計 §7、受け入れ条件 #54〜#59）。
 *
 * **記録の手前で落とす。** `access_logs` に IP は残らないので、
 * 取りこぼした 1 件は後から探して消せない。
 *
 * 設定は `primeAccessLogIpExclusions` で直接与える（この describe も DB を持たない）。
 */
describe('除外IP', () => {
  const INPUT = {
    publicKey: 'key-for-exclusion',
    path: '/pricing',
    referrer: null,
    userAgent: 'Mozilla/5.0',
  } as const;

  beforeEach(() => {
    collected.entries.length = 0;
    collected.siteLookups = 0;
    resetDailySalts();
    resetAccessLogIpExclusionsForTests();
  });

  afterEach(() => {
    resetAccessLogIpExclusionsForTests();
    collected.entries.length = 0;
    collected.siteLookups = 0;
  });

  /** #54 / #55 */
  it('除外した送信元は 1 行も記録しない', async () => {
    primeAccessLogIpExclusions(['203.0.113.10']);

    const outcome = await collectAccess({ ...INPUT, ipAddress: '203.0.113.10' });

    expect(outcome).toEqual({ ok: false });
    expect(collected.entries).toHaveLength(0);
  });

  /** #56。**公開キーの当たり判定を与えない。** */
  it('除外した送信元にはサイトの照会もしない', async () => {
    primeAccessLogIpExclusions(['203.0.113.10']);

    await collectAccess({ ...INPUT, ipAddress: '203.0.113.10' });

    expect(collected.siteLookups).toBe(0);
  });

  /** #57 */
  it('除外していない送信元は従来どおり記録する', async () => {
    primeAccessLogIpExclusions(['203.0.113.10']);

    const outcome = await collectAccess({ ...INPUT, ipAddress: '203.0.113.11' });

    expect(outcome).toEqual({ ok: true });
    expect(collected.entries).toHaveLength(1);
  });

  /** #58。IP が分からないものを落とすと、Proxy の設定ミスで計測が全損する。 */
  it('IP が取れないときは記録する', async () => {
    primeAccessLogIpExclusions(['0.0.0.0/0']);

    const outcome = await collectAccess({ ...INPUT, ipAddress: null });

    expect(outcome).toEqual({ ok: true });
    expect(collected.entries).toHaveLength(1);
  });

  /** #59 */
  it('CIDR で指定した帯の中も記録しない', async () => {
    primeAccessLogIpExclusions(['198.51.100.0/24', '2001:db8::/32']);

    await collectAccess({ ...INPUT, ipAddress: '198.51.100.77' });
    await collectAccess({ ...INPUT, ipAddress: '2001:db8:abcd::1' });
    await collectAccess({ ...INPUT, ipAddress: '198.51.101.1' });

    expect(collected.entries).toHaveLength(1);
  });

  it('ポート付き・IPv4 射影の表記でも除外する', async () => {
    primeAccessLogIpExclusions(['203.0.113.10']);

    await collectAccess({ ...INPUT, ipAddress: '203.0.113.10:51234' });
    await collectAccess({ ...INPUT, ipAddress: '::ffff:203.0.113.10' });

    expect(collected.entries).toHaveLength(0);
  });

  it('設定が空なら何も落とさない', async () => {
    primeAccessLogIpExclusions([]);

    await collectAccess({ ...INPUT, ipAddress: '203.0.113.10' });

    expect(collected.entries).toHaveLength(1);
  });

  /** パスの検査が先。除外の判定より前に落ちる経路を変えていない。 */
  it('パスが不正なら除外の判定に関わらず記録しない', async () => {
    primeAccessLogIpExclusions([]);

    const outcome = await collectAccess({ ...INPUT, path: 'javascript:alert(1)', ipAddress: null });

    expect(outcome).toEqual({ ok: false });
    expect(collected.entries).toHaveLength(0);
  });
});
