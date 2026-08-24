import type { PluginLogger } from '@torifune/plugin-api';
import { Secret } from '@/domain/secret';

/**
 * Plugin のログ。
 *
 * **Secret を渡しても平文は出ない。**
 * Plugin 作者が気をつけることに頼らず、出力の直前で落とす。
 *
 * `pluginId` を必ず付ける。どの Plugin の出力かが分からないと、
 * 障害時に切り分けられない（03_プラグイン設計.md §66）。
 */

const REDACTED = '[REDACTED]';

/** 機密になりうるキー。値を落とす。 */
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

function sanitize(value: unknown, depth = 0): unknown {
  if (value instanceof Secret) {
    return REDACTED;
  }
  if (depth > 5 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    result[key] = SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive))
      ? REDACTED
      : sanitize(item, depth + 1);
  }
  return result;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(pluginId: string, level: Level, message: string, detail?: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    pluginId,
    message,
    ...(detail === undefined ? {} : { detail: sanitize(detail) }),
  });

  if (level === 'error') {
    console.error(line);
  } else {
    console.warn(line);
  }
}

export function createPluginLogger(pluginId: string): PluginLogger {
  return {
    debug: (message, detail) => write(pluginId, 'debug', message, detail),
    info: (message, detail) => write(pluginId, 'info', message, detail),
    warn: (message, detail) => write(pluginId, 'warn', message, detail),
    error: (message, detail) => write(pluginId, 'error', message, detail),
  };
}

/** テストと監査のため、整形処理だけを取り出せるようにしておく。 */
export const sanitizeLogDetail = (detail: Record<string, unknown>): unknown => sanitize(detail);
