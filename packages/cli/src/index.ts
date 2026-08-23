import { join } from 'node:path';
import { applyMigrations } from './migrate/runner.js';

/**
 * Torifune CLI。
 *
 * `migrate` は Torifune 単体の DB 初期化に使うほか、接続先を引数で受け取れるようにして
 * おくことで、外部のプロビジョニング処理からも利用できる
 * （docs/実装計画/001-Torifune単体稼働/00_決定事項.md D-11）。
 */

export const COMMANDS = ['migrate'] as const;

export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export function usage(): string {
  return [
    'Usage: torifune <command> [options]',
    '',
    'Commands:',
    '  migrate    Apply pending migrations',
    '',
    'Options for migrate:',
    '  --database-url=<url>     Target database (default: $DATABASE_URL)',
    '  --migrations-dir=<path>  Directory of numbered SQL files',
    '  --dry-run                List pending migrations without applying them',
    '',
  ].join('\n');
}

export interface MigrateArgs {
  readonly databaseUrl: string;
  readonly migrationsDir: string;
  readonly dryRun: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** リポジトリ同梱の migrations/ を、このパッケージからの相対で解決する。 */
function defaultMigrationsDir(): string {
  // packages/cli/src → リポジトリルート
  return join(import.meta.dirname, '..', '..', '..', 'migrations');
}

export function parseMigrateArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult<MigrateArgs> {
  let databaseUrl: string | undefined;
  let migrationsDir: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    const readValue = (name: string): string | undefined => {
      const inline = `${name}=`;
      if (arg.startsWith(inline)) {
        const value = arg.slice(inline.length);
        return value === '' ? undefined : value;
      }
      if (arg === name) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          return undefined;
        }
        i += 1;
        return next;
      }
      return undefined;
    };

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--database-url')) {
      const value = readValue('--database-url');
      if (value === undefined) {
        return { ok: false, error: '--database-url に値が指定されていない' };
      }
      databaseUrl = value;
      continue;
    }

    if (arg.startsWith('--migrations-dir')) {
      const value = readValue('--migrations-dir');
      if (value === undefined) {
        return { ok: false, error: '--migrations-dir に値が指定されていない' };
      }
      migrationsDir = value;
      continue;
    }

    // 未知のオプションを黙って無視すると、打ち間違いに気づけない。
    // エラーメッセージに引数の値は含めない（接続文字列が混ざりうるため）。
    const name = arg.split('=')[0] as string;
    return { ok: false, error: `未知のオプション: ${name}` };
  }

  const resolvedUrl = databaseUrl ?? env['DATABASE_URL'];
  if (resolvedUrl === undefined || resolvedUrl === '') {
    return {
      ok: false,
      error: '接続先が指定されていない。--database-url を渡すか DATABASE_URL を設定する',
    };
  }

  return {
    ok: true,
    value: {
      databaseUrl: resolvedUrl,
      migrationsDir: migrationsDir ?? defaultMigrationsDir(),
      dryRun,
    },
  };
}

export interface RunIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const defaultIo: RunIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
};

export async function run(argv: readonly string[], io: RunIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout(usage());
    return 0;
  }

  if (!isCommand(command)) {
    io.stderr(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  const parsed = parseMigrateArgs(rest, io.env);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n\n${usage()}`);
    return 1;
  }

  try {
    const result = await applyMigrations({
      databaseUrl: parsed.value.databaseUrl,
      migrationsDir: parsed.value.migrationsDir,
      dryRun: parsed.value.dryRun,
      log: (message) => io.stdout(`${message}\n`),
    });

    if (parsed.value.dryRun) {
      io.stdout(`pending: ${result.pending.length}\n`);
    } else if (result.applied.length === 0) {
      io.stdout('no pending migrations\n');
    } else {
      io.stdout(`applied ${result.applied.length} migration(s)\n`);
    }
    return 0;
  } catch (error) {
    // applyMigrations 側で接続文字列は伏せてある。
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
