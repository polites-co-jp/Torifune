/**
 * Torifune CLI のエントリポイント。
 *
 * `migrate` は Torifune 単体の DB 初期化に使うほか、
 * 接続先を引数で受け取れるようにしておくことで、外部のプロビジョニング処理からも利用できる
 * （`docs/実装計画/001-Torifune単体稼働/00_決定事項.md` D-11）。
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
    '  migrate --database-url=<url>   Apply pending migrations to the given database',
    '',
  ].join('\n');
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return 0;
  }

  if (!isCommand(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  // migrate の実装は 001-database-foundation で追加する。
  process.stderr.write('migrate is not implemented yet (see 001-database-foundation)\n');
  return 1;
}
