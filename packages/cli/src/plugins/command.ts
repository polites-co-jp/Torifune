import { stat } from 'node:fs/promises';
import type { ParseResult, RunIo } from '../index.js';
import { failureReason, syncBundledPlugins } from './sync-bundled.js';
import { fingerprintPlugins } from './tree-hash.js';

/**
 * `torifune plugins` サブコマンド（docs/設計/050-bundled-plugin-sync/設計.md §6.6）。
 *
 * コンテナの起動手順（`docker/entrypoint.sh`）が、アプリより前に DB に繋がずに呼ぶ。
 *
 * * `plugins sync-bundled`：イメージの同梱 Plugin の写しから、plugins の Volume の同梱 Plugin を更新する
 * * `plugins fingerprint`：Plugin のソースの指紋を出す（起動時にいまのビルドと比べる）
 *
 * `index.ts` からは型だけを読む（`index.ts` がこのモジュールを読むので、実行時の循環を作らない）。
 */

/** `TORIFUNE_PLUGINS_DIR` が空・未設定のときの plugins の場所（コンテナイメージの既定）。 */
const DEFAULT_PLUGINS_DIR = '/app/plugins';

const LOG_PREFIX = '[torifune] bundled plugins: ';

/** `torifune` 全体の使い方に載せる `plugins` の部分。 */
export const PLUGINS_USAGE_LINES: readonly string[] = [
  'Subcommands of plugins:',
  '  plugins sync-bundled  Update the bundled plugins in the plugins directory',
  '                        from the copy kept in the container image',
  '  plugins fingerprint   Print the fingerprint of the plugin sources',
  '',
  'Options for plugins sync-bundled:',
  '  --bundled-dir=<path>  Copy of the bundled plugins (default: $TORIFUNE_BUNDLED_PLUGINS_DIR)',
  '  --plugins-dir=<path>  Plugins directory (default: $TORIFUNE_PLUGINS_DIR, or /app/plugins)',
  '',
  'Options for plugins fingerprint:',
  '  --plugins-dir=<path>  Plugins directory (default: $TORIFUNE_PLUGINS_DIR, or /app/plugins)',
  '',
];

function pluginsUsage(): string {
  return ['Usage: torifune plugins <subcommand> [options]', '', ...PLUGINS_USAGE_LINES].join('\n');
}

type Env = Readonly<Record<string, string | undefined>>;

/** 空の文字列は「設定されていない」として扱う。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * `--name=<value>` / `--name <value>` の形のオプションだけを読む。未知のオプションはエラーにする。
 */
function parseOptions(
  argv: readonly string[],
  names: readonly string[],
): ParseResult<Readonly<Record<string, string>>> {
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const name = arg.split('=')[0] as string;

    if (!names.includes(name)) {
      return { ok: false, error: `未知のオプション: ${name}` };
    }

    let value: string | undefined;
    if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined || value === '') {
      return { ok: false, error: `${name} に値が指定されていない` };
    }
    values[name] = value;
  }

  return { ok: true, value: values };
}

export function parseSyncBundledArgs(
  argv: readonly string[],
  env: Env,
): ParseResult<{ readonly bundledDir: string | null; readonly pluginsDir: string }> {
  const parsed = parseOptions(argv, ['--bundled-dir', '--plugins-dir']);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    value: {
      bundledDir:
        parsed.value['--bundled-dir'] ?? nonEmpty(env['TORIFUNE_BUNDLED_PLUGINS_DIR']) ?? null,
      pluginsDir:
        parsed.value['--plugins-dir'] ??
        nonEmpty(env['TORIFUNE_PLUGINS_DIR']) ??
        DEFAULT_PLUGINS_DIR,
    },
  };
}

export function parseFingerprintArgs(
  argv: readonly string[],
  env: Env,
): ParseResult<{ readonly pluginsDir: string }> {
  const parsed = parseOptions(argv, ['--plugins-dir']);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    value: {
      pluginsDir:
        parsed.value['--plugins-dir'] ??
        nonEmpty(env['TORIFUNE_PLUGINS_DIR']) ??
        DEFAULT_PLUGINS_DIR,
    },
  };
}

/** 同梱の写しの場所がディレクトリとして存在するか。無い・ディレクトリでなければ false。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

async function runSyncBundled(argv: readonly string[], io: RunIo): Promise<number> {
  const parsed = parseSyncBundledArgs(argv, io.env);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n\n${pluginsUsage()}`);
    return 1;
  }
  const { bundledDir, pluginsDir } = parsed.value;

  // 同梱の写しの場所が無い（イメージの外で動かしている）なら何もしない
  try {
    if (bundledDir === null || !(await isDirectory(bundledDir))) {
      io.stdout(`${LOG_PREFIX}no bundled directory, skipped\n`);
      return 0;
    }
  } catch (error) {
    io.stderr(`${LOG_PREFIX}FAILED: ${failureReason(error)}\n`);
    return 1;
  }

  const result = await syncBundledPlugins({
    bundledDir,
    pluginsDir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  return result.exitCode;
}

async function runFingerprint(argv: readonly string[], io: RunIo): Promise<number> {
  const parsed = parseFingerprintArgs(argv, io.env);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n\n${pluginsUsage()}`);
    return 1;
  }

  let fingerprint: string;
  try {
    fingerprint = await fingerprintPlugins(parsed.value.pluginsDir);
  } catch (error) {
    // 読めないファイルがあれば標準出力には何も出さない（起動手順は食い違いとして扱わない）
    io.stderr(`[torifune] plugins fingerprint FAILED: ${failureReason(error)}\n`);
    return 1;
  }
  io.stdout(`${fingerprint}\n`);
  return 0;
}

export async function runPlugins(argv: readonly string[], io: RunIo): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand === 'sync-bundled') {
    return runSyncBundled(rest, io);
  }
  if (subcommand === 'fingerprint') {
    return runFingerprint(rest, io);
  }

  const error =
    subcommand === undefined
      ? 'plugins のサブコマンドが指定されていない'
      : `未知のサブコマンド: plugins ${subcommand}`;
  io.stderr(`${error}\n\n${pluginsUsage()}`);
  return 1;
}
