import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 手動投稿の子ウィンドウの開き方（055-social-pending-tab 設計 §6・§9.3.4・§9.5.2、受け入れ条件 #49 の定数側）。
 *
 * `manual-pending.tsx`（035-social-publishing 設計 §7.2）の窓の名前・開き方の定数と `window.open` の呼び出しを
 * `ui/social/manual-handoff.ts` へ移す（送信待ちの表と順に投稿のダイアログが使う）。
 * `manual-pending.test.ts` の「子ウィンドウ」の件のうち部品に依らないもの（窓の名前・`noopener`・`noreferrer`・
 * `open` を渡さないとき `window.open` を同じ引数で呼ぶ）をここへ移す（実装プラン §8 の 7）。
 * 部品が押されたときに `open` を呼ぶことは `social-pending.test.ts`（#49）が見る。
 *
 * * 窓の名前を `torifune-manual-post` に固定する：同じ名前を使い回すので、2 件目を開いても窓が増えない
 * * `noopener`・`noreferrer`：開いた先から `window.opener` で Torifune の画面へ戻れる状態にしない
 *
 * `ui/social/manual-handoff.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。`open` を差し替えの口にするのは、この環境（`environment: 'node'`）に
 * `window` が無いため（035 実装プラン §8 の 10）。
 */

type OpenWindow = (url: string, name: string, features: string) => unknown;

interface ManualHandoffModule {
  readonly MANUAL_WINDOW_NAME: string;
  readonly MANUAL_WINDOW_FEATURES: string;
  readonly openManualWindow: (url: string, open?: OpenWindow) => unknown;
}

const MODULE: string = '@/ui/social/manual-handoff';

async function load(): Promise<ManualHandoffModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Partial<ManualHandoffModule>;
  if (typeof module.openManualWindow !== 'function') {
    throw new Error('ui/social/manual-handoff.ts に openManualWindow が無い');
  }
  for (const name of ['MANUAL_WINDOW_NAME', 'MANUAL_WINDOW_FEATURES'] as const) {
    if (typeof module[name] !== 'string') {
      throw new Error(`ui/social/manual-handoff.ts に ${name} が無い`);
    }
  }
  return module as ManualHandoffModule;
}

const URL_A = 'https://bsky.app/intent/compose?text=a';
const URL_B = 'https://bsky.app/intent/compose?text=b';

/** 設計 #49 の字面。 */
const WINDOW_NAME = 'torifune-manual-post';
const WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#49 窓の名前と開き方の定数', () => {
  it('#49 窓の名前は torifune-manual-post', async () => {
    const { MANUAL_WINDOW_NAME } = await load();

    expect(MANUAL_WINDOW_NAME).toBe(WINDOW_NAME);
  });

  it('#49 開き方は popup=yes,width=600,height=720,noopener=yes,noreferrer=yes', async () => {
    const { MANUAL_WINDOW_FEATURES } = await load();

    expect(MANUAL_WINDOW_FEATURES).toBe(WINDOW_FEATURES);
  });

  it('#49 開き方に noopener を含める', async () => {
    const { MANUAL_WINDOW_FEATURES } = await load();

    expect(MANUAL_WINDOW_FEATURES).toMatch(/noopener/);
  });

  it('#49 開き方に noreferrer を含める', async () => {
    const { MANUAL_WINDOW_FEATURES } = await load();

    expect(MANUAL_WINDOW_FEATURES).toMatch(/noreferrer/);
  });
});

describe('#49 openManualWindow', () => {
  it('#49 渡した open を 1 回呼ぶ', async () => {
    const { openManualWindow } = await load();
    const open = vi.fn();

    openManualWindow(URL_A, open);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('#49 open を (url, 窓の名前, 開き方) のちょうど 3 つの引数で呼ぶ', async () => {
    const { openManualWindow } = await load();
    const open = vi.fn();

    openManualWindow(URL_A, open);

    expect(open.mock.calls[0]).toEqual([URL_A, WINDOW_NAME, WINDOW_FEATURES]);
  });

  it('#49 2 件目も同じ窓の名前で開く（窓が増えない）', async () => {
    const { openManualWindow } = await load();
    const open = vi.fn();

    openManualWindow(URL_A, open);
    openManualWindow(URL_B, open);

    expect(open.mock.calls.map((call) => call[1])).toEqual([WINDOW_NAME, WINDOW_NAME]);
    expect(open.mock.calls[1]?.[0]).toBe(URL_B);
  });

  it('#49 open を渡さないときは window.open を同じ引数で呼ぶ', async () => {
    const { openManualWindow } = await load();
    const windowOpen = vi.fn();
    vi.stubGlobal('window', { open: windowOpen });

    openManualWindow(URL_A);

    expect(windowOpen).toHaveBeenCalledTimes(1);
    expect(windowOpen.mock.calls[0]).toEqual([URL_A, WINDOW_NAME, WINDOW_FEATURES]);
  });
});
