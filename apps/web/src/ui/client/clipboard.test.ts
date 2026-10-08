import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 文字列をクリップボードへ写す `copyText`（051-social-account-id-display 設計 §7.3.2・§7.3.3、
 * 受け入れ条件 #11〜#15）。
 *
 * ```ts
 * export interface ClipboardWriter { writeText(text: string): Promise<void>; }
 * export async function copyText(
 *   text: string,
 *   clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
 * ): Promise<boolean>;
 * ```
 *
 * * Clipboard API だけを使い、**例外を投げず `boolean` を返す**
 * * クリップボードの偽物（外部境界）だけを差し替える。`globalThis.navigator` は `vi.stubGlobal` で替え、
 *   件ごとに戻す
 * * #12 の「`undefined` を明示して渡す」は、JavaScript では省略と同じく既定値の式が評価される。
 *   そのため `navigator` を `clipboard` の無い形に替えてから渡す（実装プラン §8 の 1）
 *
 * `ui/client/clipboard.ts` はまだ無いので、指定子を定数に置いた動的 import で読む
 * （T1 の時点で型検査を緑に保つため。モジュールができた後もこのまま動く）。
 */

interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

interface ClipboardModule {
  copyText(text: string, clipboard?: ClipboardWriter | undefined): Promise<boolean>;
}

const CLIPBOARD_MODULE = './clipboard';
let clipboardModule: Promise<ClipboardModule> | undefined;

function loadClipboard(): Promise<ClipboardModule> {
  clipboardModule ??= import(/* @vite-ignore */ CLIPBOARD_MODULE) as Promise<ClipboardModule>;
  return clipboardModule;
}

const ACCOUNT_ID = '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23';

/** 書き込みを記録するだけの偽物。 */
function fakeWriter() {
  return { writeText: vi.fn(async (_text: string): Promise<void> => {}) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('#11 writeText をその文字列で 1 回だけ呼び、true を返す', async () => {
    const { copyText } = await loadClipboard();
    const writer = fakeWriter();

    const copied = await copyText(ACCOUNT_ID, writer);

    expect(copied).toBe(true);
    expect(writer.writeText).toHaveBeenCalledTimes(1);
    expect(writer.writeText).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('#12 第 2 引数に undefined を明示して渡すと（クリップボードが無いとき）false を返し、例外を投げない', async () => {
    const { copyText } = await loadClipboard();
    // Node の素の navigator に頼らず、clipboard の無い状態を作る。
    vi.stubGlobal('navigator', {});

    await expect(copyText(ACCOUNT_ID, undefined)).resolves.toBe(false);
  });

  it('#13 writeText が NotAllowedError の DOMException で reject すると false を返し、例外を投げない', async () => {
    const { copyText } = await loadClipboard();
    const writer: ClipboardWriter = {
      writeText: vi.fn(async (_text: string) => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    };

    await expect(copyText(ACCOUNT_ID, writer)).resolves.toBe(false);
    expect(writer.writeText).toHaveBeenCalledTimes(1);
  });

  it('#14 writeText が同期で例外を投げても false を返し、例外を投げない', async () => {
    const { copyText } = await loadClipboard();
    const writer: ClipboardWriter = {
      writeText: vi.fn((_text: string): Promise<void> => {
        throw new TypeError('writeText is not available');
      }),
    };

    await expect(copyText(ACCOUNT_ID, writer)).resolves.toBe(false);
    expect(writer.writeText).toHaveBeenCalledTimes(1);
  });
});

describe('既定のクリップボード', () => {
  it('#15 第 2 引数を省略すると globalThis.navigator.clipboard を使い、true を返す', async () => {
    const { copyText } = await loadClipboard();
    const writer = fakeWriter();
    vi.stubGlobal('navigator', { clipboard: writer });

    const copied = await copyText(ACCOUNT_ID);

    expect(copied).toBe(true);
    expect(writer.writeText).toHaveBeenCalledTimes(1);
    expect(writer.writeText).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('#15 第 2 引数を省略し、navigator に clipboard が無ければ false を返す', async () => {
    const { copyText } = await loadClipboard();
    vi.stubGlobal('navigator', {});

    await expect(copyText(ACCOUNT_ID)).resolves.toBe(false);
  });
});
