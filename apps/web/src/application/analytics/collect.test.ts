import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { trackingScript, trackingScriptEtag } from '@/application/analytics/collect';

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
