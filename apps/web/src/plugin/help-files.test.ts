import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPluginHelpFile, type HelpFileResult } from './help-files';

/**
 * 手順書のファイルの読み出し（041-plugin-help-docs 設計 §6.2、受け入れ条件 #8〜#15）。
 *
 * **Plugin のフォルダの中に限って読む。** Manifest の検査（§6.1）を通った `path` しか
 * 渡らない前提だが、ここでも独立に確かめる（検証を 1 か所に頼らない）。
 * 失敗は例外にせず理由のコードだけを返し、パスや OS のエラー文言を返さない。
 *
 * 一時フォルダの配置：
 *
 * ```text
 * <root>/
 *   outside.md          … Plugin のフォルダの外（読まれてはならない）
 *   help-plugin/        … Plugin のフォルダ（pluginDirectory）
 *     help/…
 * ```
 */

const OUTSIDE_TEXT = 'OUTSIDE-SECRET-3F9 この文字列は Plugin のフォルダの外にある';

/**
 * シンボリックリンクを作れるか（設計 #10・#11 の注）。
 *
 * Windows では権限（開発者モード・管理者）が無いとファイルのシンボリックリンクを作れない。
 * **作れない環境ではその 1 件だけを飛ばし、飛ばしたことを出力に残す。**
 * CI（Linux）では常に作れる。
 */
function probeLink(kind: 'file' | 'dir'): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'torifune-help-probe-'));
  try {
    const target = join(probe, kind === 'file' ? 'target.txt' : 'target');
    if (kind === 'file') {
      writeFileSync(target, 'x');
    } else {
      mkdirSync(target);
    }
    symlinkSync(target, join(probe, 'link'), kind === 'file' ? 'file' : dirLinkType());
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** フォルダのリンクの種類。Windows では権限なしで作れる junction を使う（実装プラン §2）。 */
function dirLinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

const CAN_LINK_FILE = probeLink('file');
const CAN_LINK_DIR = probeLink('dir');

if (!CAN_LINK_FILE) {
  console.info(
    '[help-files.test] シンボリックリンク（ファイル）を作れないため、#10 と関連のケースを飛ばした',
  );
}
if (!CAN_LINK_DIR) {
  console.info('[help-files.test] フォルダのリンクを作れないため、#11 を飛ばした');
}

let root: string;
let pluginDirectory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'torifune-help-'));
  pluginDirectory = join(root, 'help-plugin');
  await mkdir(join(pluginDirectory, 'help'), { recursive: true });
  await writeFile(join(root, 'outside.md'), OUTSIDE_TEXT, 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relativePath: string, content: string | Uint8Array): Promise<void> {
  const target = join(pluginDirectory, relativePath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}

function expectFailure(result: HelpFileResult, reason: string): void {
  expect(result).toStrictEqual({ ok: false, reason });
}

describe('#8 読める手順書', () => {
  it('#8 UTF-8（BOM つき）の本文は BOM を除いた本文ちょうどで返る', async () => {
    const body = '# 題名\n\n本文です。\n';
    await put('help/a.md', `\uFEFF${body}`);

    const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

    expect(result).toStrictEqual({ ok: true, markdown: body });
  });

  it('#8 BOM の無い本文はそのまま返る', async () => {
    const body = '## 手順 1\n\n- 押す\n';
    await put('help/a.md', body);

    const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

    expect(result).toStrictEqual({ ok: true, markdown: body });
  });

  it('#8 BOM は先頭の 1 つだけを除く（本文の 2 つ目の U+FEFF は残る）', async () => {
    await put('help/a.md', '\uFEFF\uFEFFx');

    const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

    expect(result).toStrictEqual({ ok: true, markdown: '\uFEFFx' });
  });
});

describe('#9 無い・ファイルでない', () => {
  it('#9 無いファイル → not_found', async () => {
    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/missing.md'), 'not_found');
  });

  it('#9 help/a.md という名のフォルダ → not_file', async () => {
    await mkdir(join(pluginDirectory, 'help', 'a.md'), { recursive: true });

    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/a.md'), 'not_file');
  });
});

describe('#10 フォルダの中のシンボリックリンクが外を指す', () => {
  it.skipIf(!CAN_LINK_FILE)(
    '#10 help/a.md がフォルダの外のファイルを指す → outside_plugin_dir で、外の中身を返さない',
    async () => {
      await symlink(join(root, 'outside.md'), join(pluginDirectory, 'help', 'a.md'), 'file');

      const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

      expectFailure(result, 'outside_plugin_dir');
      expect(JSON.stringify(result)).not.toContain('OUTSIDE-SECRET-3F9');
    },
  );

  it.skipIf(!CAN_LINK_FILE)(
    '#10 フォルダの中を指すシンボリックリンクは読める（実体がフォルダの中）',
    async () => {
      await put('docs/real.md', '中の本文');
      await symlink(
        join(pluginDirectory, 'docs', 'real.md'),
        join(pluginDirectory, 'help', 'a.md'),
        'file',
      );

      expect(await readPluginHelpFile(pluginDirectory, 'help/a.md')).toStrictEqual({
        ok: true,
        markdown: '中の本文',
      });
    },
  );

  it.skipIf(!CAN_LINK_FILE)('#10 行き先の無いシンボリックリンク → not_found', async () => {
    await symlink(join(root, 'nowhere.md'), join(pluginDirectory, 'help', 'a.md'), 'file');

    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/a.md'), 'not_found');
  });

  it.skipIf(!CAN_LINK_DIR)(
    '#10 フォルダの中のフォルダのリンクが外を指す（help → 外）→ outside_plugin_dir',
    async () => {
      await rm(join(pluginDirectory, 'help'), { recursive: true, force: true });
      const outsideDir = join(root, 'outside-help');
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, 'a.md'), OUTSIDE_TEXT, 'utf8');
      await symlink(outsideDir, join(pluginDirectory, 'help'), dirLinkType());

      const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

      expectFailure(result, 'outside_plugin_dir');
      expect(JSON.stringify(result)).not.toContain('OUTSIDE-SECRET-3F9');
    },
  );
});

describe('#11 Plugin のフォルダそのものがシンボリックリンク', () => {
  it.skipIf(!CAN_LINK_DIR)(
    '#11 リンクを通した pluginDirectory でも中のファイルは読める',
    async () => {
      await put('help/a.md', 'リンク越しの本文');
      const linked = join(root, 'linked-plugin');
      await symlink(pluginDirectory, linked, dirLinkType());

      expect(await readPluginHelpFile(linked, 'help/a.md')).toStrictEqual({
        ok: true,
        markdown: 'リンク越しの本文',
      });
    },
  );
});

describe('#12 Manifest の検査を迂回したパス', () => {
  it("#12 '../outside.md' → outside_plugin_dir で、外の同名のファイルが実在しても読まない", async () => {
    const result = await readPluginHelpFile(pluginDirectory, '../outside.md');

    expectFailure(result, 'outside_plugin_dir');
    expect(JSON.stringify(result)).not.toContain('OUTSIDE-SECRET-3F9');
  });

  it("#12 'help/../../outside.md'（途中で外へ出る）→ outside_plugin_dir", async () => {
    expectFailure(
      await readPluginHelpFile(pluginDirectory, 'help/../../outside.md'),
      'outside_plugin_dir',
    );
  });

  it('#12 実在する外のファイルの絶対パスを直接渡す → outside_plugin_dir（Windows ではドライブ名つき）', async () => {
    const result = await readPluginHelpFile(pluginDirectory, join(root, 'outside.md'));

    expectFailure(result, 'outside_plugin_dir');
    expect(JSON.stringify(result)).not.toContain('OUTSIDE-SECRET-3F9');
  });

  it('#12 / 区切りで書いた外の絶対パスも outside_plugin_dir', async () => {
    const forward = join(root, 'outside.md').replaceAll('\\', '/');

    expectFailure(await readPluginHelpFile(pluginDirectory, forward), 'outside_plugin_dir');
  });

  it("#12 空のパス・'.'（Plugin のフォルダそのもの）→ outside_plugin_dir", async () => {
    expectFailure(await readPluginHelpFile(pluginDirectory, ''), 'outside_plugin_dir');
    expectFailure(await readPluginHelpFile(pluginDirectory, '.'), 'outside_plugin_dir');
  });

  it.each([
    ['バックスラッシュで外へ出る', '..\\outside.md'],
    ['URL', 'https://example.com/outside.md'],
    ['file の URL', 'file:///outside.md'],
  ])('#12 %s（%s）を渡しても外の中身を読まず、例外も投げない', async (_label, relativePath) => {
    // OS によって「外（outside_plugin_dir）」か「中の無いファイル（not_found）」かが分かれる
    // （POSIX ではバックスラッシュ・`https:` はファイル名の一部）。どちらでも外は読まない。
    const result = await readPluginHelpFile(pluginDirectory, relativePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['outside_plugin_dir', 'not_found']).toContain(result.reason);
    expect(JSON.stringify(result)).not.toContain('OUTSIDE-SECRET-3F9');
  });
});

describe('#94 D1：ファイルに触れる前（手順 2）に外へ出るパスを止める', () => {
  /**
   * 外に**そのファイルが無い**パスを渡す。手順 2（`resolve` の結果が Plugin のフォルダの中か）を
   * 飛ばして手順 3（`realpath`）へ進む実装だと、ファイルが無いので `not_found` になる。
   * `outside_plugin_dir` が返ることで、ファイルに触れる前に止まったことを判別する。
   */
  it("#94 '../missing.md'（フォルダの外にそのファイルが無い）→ not_found ではなく outside_plugin_dir", async () => {
    expectFailure(await readPluginHelpFile(pluginDirectory, '../missing.md'), 'outside_plugin_dir');
  });

  it("#94 'help/../../missing.md'（途中で外へ出て、そこにファイルが無い）→ outside_plugin_dir", async () => {
    expectFailure(
      await readPluginHelpFile(pluginDirectory, 'help/../../missing.md'),
      'outside_plugin_dir',
    );
  });

  it('#94 対の条件：フォルダの中の無いファイル（help/missing.md）は not_found', async () => {
    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/missing.md'), 'not_found');
  });
});

describe('#13 大きさの上限（262144 バイト）', () => {
  it('#13 262144 バイトちょうど → ok: true で本文が欠けない', async () => {
    await put('help/a.md', 'a'.repeat(262144));

    const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toHaveLength(262144);
  });

  it('#13 262145 バイト → too_large', async () => {
    await put('help/a.md', 'a'.repeat(262145));

    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/a.md'), 'too_large');
  });

  it('#13 上限は文字数ではなくバイト数で数える（3 バイトの文字で 262145 バイト）', async () => {
    // 'あ' は UTF-8 で 3 バイト。87381 文字 = 262143 バイト、＋ 'aa' で 262145 バイト。
    await put('help/a.md', `${'あ'.repeat(87381)}aa`);

    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/a.md'), 'too_large');
  });
});

describe('#14 文字コード', () => {
  it('#14 UTF-8 として不正なバイト列（0xFF 0xFE 0x00）→ invalid_encoding', async () => {
    await put('help/a.md', new Uint8Array([0xff, 0xfe, 0x00]));

    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/a.md'), 'invalid_encoding');
  });

  it('#14 途中に不正なバイトがあっても置き換えずに invalid_encoding', async () => {
    const valid = new TextEncoder().encode('前半');
    await put('help/a.md', new Uint8Array([...valid, 0xc3, 0x28]));

    expectFailure(await readPluginHelpFile(pluginDirectory, 'help/a.md'), 'invalid_encoding');
  });
});

describe('#15 例外を投げず、理由のコードだけを返す', () => {
  it('#15 どの失敗でも例外を投げず、戻り値のキーは ok と reason だけで、パスも OS の文言も含まない', async () => {
    await mkdir(join(pluginDirectory, 'help', 'dir.md'));
    await put('help/big.md', 'a'.repeat(262145));
    await put('help/bad.md', new Uint8Array([0xff, 0xfe, 0x00]));

    const inputs: readonly (readonly [string, string])[] = [
      [pluginDirectory, 'help/missing.md'],
      [pluginDirectory, 'help/dir.md'],
      [pluginDirectory, '../outside.md'],
      [pluginDirectory, join(root, 'outside.md')],
      [pluginDirectory, 'help/big.md'],
      [pluginDirectory, 'help/bad.md'],
      // Plugin のフォルダそのものが無い（上の表に無い失敗は not_found に寄せる）
      [join(root, 'no-such-plugin'), 'help/a.md'],
    ];

    for (const [directory, relativePath] of inputs) {
      const result = await readPluginHelpFile(directory, relativePath);

      expect(result.ok, relativePath).toBe(false);
      expect(Object.keys(result).sort(), relativePath).toEqual(['ok', 'reason']);
      const serialized = JSON.stringify(result);
      expect(serialized, relativePath).not.toContain(root);
      expect(serialized, relativePath).not.toContain(root.replaceAll('\\', '/'));
      expect(serialized, relativePath).not.toContain('help-plugin');
      expect(serialized, relativePath).not.toMatch(/ENOENT|EISDIR|EACCES|EPERM|ELOOP/);
    }
  });

  it('#15 Plugin のフォルダそのものが無い → 例外を投げず not_found', async () => {
    expectFailure(await readPluginHelpFile(join(root, 'no-such-plugin'), 'help/a.md'), 'not_found');
  });

  it('#15 成功の戻り値のキーは ok と markdown だけ', async () => {
    await put('help/a.md', '本文');

    const result = await readPluginHelpFile(pluginDirectory, 'help/a.md');

    expect(Object.keys(result).sort()).toEqual(['markdown', 'ok']);
  });
});
