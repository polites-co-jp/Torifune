import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { PLUGIN_HELP_LIMITS } from '@torifune/plugin-api';

/**
 * Plugin が同梱する手順書のファイルを読む（041 設計 §6.2）。
 *
 * **Plugin のフォルダの中に限って読む。** Manifest の検査（`validateManifest` の `help`）を
 * 通った `path` しか渡らない前提だが、ここでも独立に確かめる。
 * 検証を 1 か所に頼ると、そこを直したときに気づけない（`extractPackage` の二重の確認と同じ考え）。
 *
 * 要求のたびに読む。埋め込みもキャッシュもしない（設計 §4.1）。
 * 失敗は例外にせず理由のコードだけを返す。パスや OS のエラー文言は返さない。
 */

export type HelpFileFailure =
  /** 無い（上に無い失敗もここへ寄せる） */
  | 'not_found'
  /** フォルダなど、通常のファイルでない */
  | 'not_file'
  /** 実体が Plugin のフォルダの外（シンボリックリンク・.. など） */
  | 'outside_plugin_dir'
  /** `PLUGIN_HELP_LIMITS.maxFileBytes` を超える */
  | 'too_large'
  /** UTF-8 として読めない */
  | 'invalid_encoding';

export type HelpFileResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly reason: HelpFileFailure };

function failure(reason: HelpFileFailure): HelpFileResult {
  return { ok: false, reason };
}

/** `path` が `base` の中（`base` そのものは含まない）にあるか。 */
function isInside(base: string, path: string): boolean {
  return path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * `pluginDirectory` の中の `relativePath` を読む。
 *
 * テストのためにフォルダを引数で受ける。本番では `pluginDir(pluginId)` を渡す。
 */
export async function readPluginHelpFile(
  pluginDirectory: string,
  relativePath: string,
): Promise<HelpFileResult> {
  try {
    // 1. Plugin のフォルダそのものがシンボリックリンクでもよい（開発で plugins/ を張ることがある）。
    let base: string;
    try {
      base = await realpath(pluginDirectory);
    } catch {
      return failure('not_found');
    }

    // 2. **ファイルに触れる前に**、組み立てたパスがフォルダの外へ出ないことを確かめる。
    const candidate = resolve(base, relativePath);
    if (!isInside(base, candidate)) {
      return failure('outside_plugin_dir');
    }

    // 3. フォルダの中のシンボリックリンクが外を指す場合を、実体のパスで確かめる。
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      return failure('not_found');
    }
    if (!isInside(base, real)) {
      return failure('outside_plugin_dir');
    }

    // 4. **読む前に**大きさで断る。
    const info = await stat(real);
    if (!info.isFile()) {
      return failure('not_file');
    }
    if (info.size > PLUGIN_HELP_LIMITS.maxFileBytes) {
      return failure('too_large');
    }

    const bytes = await readFile(real);
    // 6. 読んでいる間に大きくなった場合に備え、読んだバイト数でも確かめる。
    if (bytes.byteLength > PLUGIN_HELP_LIMITS.maxFileBytes) {
      return failure('too_large');
    }

    // 5. 置き換えずに不正を検出する。先頭の BOM（U+FEFF）は 1 つだけ除く（TextDecoder の既定）。
    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return failure('invalid_encoding');
    }
    return { ok: true, markdown };
  } catch {
    // EACCES など上に無い失敗。理由のコードだけを返し、OS の文言を外へ出さない。
    return failure('not_found');
  }
}
