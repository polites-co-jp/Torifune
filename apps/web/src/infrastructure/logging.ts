import { Secret } from '@/domain/secret';

/**
 * ロギング基盤（07_開発者向けガイド.md §36）。
 *
 * **`console.*` を直接呼ばない。** 直接呼ぶと、出力の形式が揃わず、
 * 機密を落とす処理も通らない。ESLint で直接呼び出しを禁止している。
 *
 * 出力は1行の JSON。集約基盤で扱えることを優先する。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

const REDACTED = '[REDACTED]';

/**
 * 機密になりうるキー。値を落とす。
 *
 * `plugin/logger.ts` と同じ集合。**片方だけ増やさない。**
 */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'credential',
  'cookie',
  'authorization',
  'apikey',
  'sessionid',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function mask(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Secret) {
    return REDACTED;
  }
  if (depth > 5 || value === null || typeof value !== 'object') {
    return value;
  }

  // 循環参照でログの整形が落ちると、本来出したかった情報ごと失う。
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => mask(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : mask(item, depth + 1, seen);
  }
  return result;
}

/**
 * 機密を落とす。
 *
 * 「入れない」を規約に頼ると、いつか入る。出力の直前で機械的に落とす。
 */
export function maskSecrets(value: unknown): unknown {
  return mask(value, 0, new WeakSet<object>());
}

/**
 * 既定の出力先。
 *
 * `error` だけ `console.error` へ出す。運用側で深刻度を振り分けられるようにする。
 */
export const consoleLogger: Logger = {
  log(level, message, fields) {
    const line = JSON.stringify({
      level,
      message,
      ...(fields === undefined ? {} : { fields }),
    });
    /* eslint-disable no-console -- ログの出力口をここ1箇所に閉じる（07_開発者向けガイド.md §36） */
    if (level === 'error') {
      console.error(line);
    } else {
      console.warn(line);
    }
    /* eslint-enable no-console */
  },
};

let current: Logger = consoleLogger;

export function setLogger(next: Logger): void {
  current = next;
}

export function resetLogger(): void {
  current = consoleLogger;
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  try {
    current.log(
      level,
      message,
      fields === undefined ? undefined : (maskSecrets(fields) as Record<string, unknown>),
    );
  } catch {
    // 出力先が壊れていることと、処理を続けられないことは別。
    // ログの失敗でアプリを止めない。
  }
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
