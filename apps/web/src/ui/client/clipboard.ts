/** 書き込みだけを使う（読み取りの権限は要らない）。 */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/**
 * 文字列をクリップボードへ写す（051-social-account-id-display 設計 §7.3）。
 * 写せたら true、写せなければ false。**例外を投げない。**
 *
 * `navigator.clipboard` は安全なコンテキスト（https / localhost）でしか生えない。http で開いた画面では
 * undefined なので false を返し、呼び出し側が「選択して写す」よう伝える。execCommand の代替は置かない。
 */
export async function copyText(
  text: string,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
