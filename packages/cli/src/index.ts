import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { applyMigrations } from './migrate/runner.js';
import {
  InvalidPasswordError,
  resetPassword,
  UserNotFoundError,
} from './reset-password/reset-password.js';

/**
 * Torifune CLI。
 *
 * `migrate` は Torifune 単体の DB 初期化に使うほか、接続先を引数で受け取れるようにして
 * おくことで、外部のプロビジョニング処理からも利用できる
 * （docs/実装計画/001-Torifune単体稼働/00_決定事項.md D-11）。
 *
 * `reset-password` は、画面からのパスワードリセットが使えない環境のための復旧経路
 * （`03_リスクと未決事項.md` S-8）。メール送信を用意していない構成では、
 * 管理者が1人だとその管理者が締め出された時点で復旧できなくなる。
 */

export const COMMANDS = ['migrate', 'reset-password'] as const;

export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export function usage(): string {
  return [
    'Usage: torifune <command> [options]',
    '',
    'Commands:',
    '  migrate         Apply pending migrations',
    '  reset-password  Reset a user password directly in the database',
    '',
    'Options for migrate:',
    '  --database-url=<url>     Target database (default: $DATABASE_URL)',
    '  --migrations-dir=<path>  Directory of numbered SQL files',
    '  --dry-run                List pending migrations without applying them',
    '',
    'Options for reset-password:',
    '  --login-id=<id>          Login ID of the user to reset (required)',
    '  --database-url=<url>     Target database (default: $DATABASE_URL)',
    '  --generate               Generate a password and print it once',
    '',
    'The new password is read from stdin unless --generate is given.',
    'It is never accepted as a command line argument, because arguments',
    'are visible in the shell history and in the process list.',
    '',
    '  printf %s "$NEW_PASSWORD" | torifune reset-password --login-id=admin',
    '  torifune reset-password --login-id=admin --generate',
    '',
    'Resetting a password revokes every active session of that user.',
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

export interface ResetPasswordArgs {
  readonly databaseUrl: string;
  readonly loginId: string;
  readonly generate: boolean;
}

/**
 * `reset-password` の引数を読む。
 *
 * **パスワードを引数で受け取らない。** 引数はシェルの履歴と `ps` に平文で残る。
 * 標準入力か `--generate` のどちらかで受け取る。
 */
export function parseResetPasswordArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult<ResetPasswordArgs> {
  let databaseUrl: string | undefined;
  let loginId: string | undefined;
  let generate = false;

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

    if (arg === '--generate') {
      generate = true;
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

    if (arg.startsWith('--login-id')) {
      const value = readValue('--login-id');
      if (value === undefined) {
        return { ok: false, error: '--login-id に値が指定されていない' };
      }
      loginId = value;
      continue;
    }

    // エラーメッセージに引数の値は含めない
    // （接続文字列やパスワードが混ざりうるため）。
    const name = arg.split('=')[0] as string;
    if (name === '--password') {
      return {
        ok: false,
        error:
          'パスワードは引数で受け取らない。シェルの履歴と ps に残るため。' +
          '標準入力へ渡すか --generate を使う',
      };
    }
    return { ok: false, error: `未知のオプション: ${name}` };
  }

  if (loginId === undefined) {
    return { ok: false, error: '--login-id が指定されていない' };
  }

  const resolvedUrl = databaseUrl ?? env['DATABASE_URL'];
  if (resolvedUrl === undefined || resolvedUrl === '') {
    return {
      ok: false,
      error: '接続先が指定されていない。--database-url を渡すか DATABASE_URL を設定する',
    };
  }

  return { ok: true, value: { databaseUrl: resolvedUrl, loginId, generate } };
}

/**
 * 生成するパスワード。
 *
 * 人が覚える前提を置かない。生成したら控えて、ログイン後に本人が変える。
 */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

export interface RunIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 標準入力を最後まで読む。`reset-password` がパスワードの受け取りに使う。 */
  readonly readStdin: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const defaultIo: RunIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  readStdin: readAllStdin,
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

  if (command === 'reset-password') {
    return runResetPassword(rest, io);
  }

  return runMigrate(rest, io);
}

async function runResetPassword(rest: readonly string[], io: RunIo): Promise<number> {
  const parsed = parseResetPasswordArgs(rest, io.env);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n\n${usage()}`);
    return 1;
  }

  const { databaseUrl, loginId, generate } = parsed.value;

  const generated = generate ? generatePassword() : undefined;
  // 末尾の改行は取り除く。`printf` と `echo` で結果が変わると分かりにくい。
  const newPassword = generated ?? (await io.readStdin()).replace(/\r?\n$/, '');

  if (newPassword === '') {
    io.stderr('新しいパスワードが空である。標準入力へ渡すか --generate を使う\n\n' + usage());
    return 1;
  }

  try {
    const result = await resetPassword({ databaseUrl, loginId, newPassword });

    io.stdout(`password reset: ${result.loginId} (${result.userId})\n`);
    io.stdout(`revoked sessions: ${result.revokedSessions}\n`);
    if (generated !== undefined) {
      // 一度しか出さない。保存していないので、後から取り出す手段は無い。
      io.stdout(`generated password: ${generated}\n`);
      io.stdout('この表示は一度だけ。控えたうえで、ログイン後に変更すること\n');
    }
    return 0;
  } catch (error) {
    if (error instanceof UserNotFoundError || error instanceof InvalidPasswordError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    // resetPassword 側で接続文字列は伏せてある。
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runMigrate(rest: readonly string[], io: RunIo): Promise<number> {
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
