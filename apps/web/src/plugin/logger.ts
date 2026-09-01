import type { PluginLogger } from '@torifune/plugin-api';
import { log, maskSecrets } from '@/infrastructure/logging';

/**
 * Plugin のログ。
 *
 * **Secret を渡しても平文は出ない。**
 * Plugin 作者が気をつけることに頼らず、出力の直前で落とす。
 * 落とす処理は本体と共通（`infrastructure/logging.ts`）。
 * **片方だけ機密キーを増やす事故を避けるため、実装を分けない。**
 *
 * `pluginId` を必ず付ける。どの Plugin の出力かが分からないと、
 * 障害時に切り分けられない（03_プラグイン設計.md §66）。
 */

export function createPluginLogger(pluginId: string): PluginLogger {
  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    log[level](message, { pluginId, ...(detail === undefined ? {} : { detail }) });
  };

  return {
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  };
}

/** テストと監査のため、整形処理だけを取り出せるようにしておく。 */
export const sanitizeLogDetail = (detail: Record<string, unknown>): unknown => maskSecrets(detail);
