import { join } from 'node:path';

/**
 * `plugins/` の場所。
 *
 * ビルド時の生成スクリプトと実行時のアプリが**同じ場所**を見る必要がある。
 * 別々に組み立てると、片方だけ直したときに静かにずれる。
 */

/** 隔離マーク。これがあるディレクトリはビルド時に読み込まない。 */
export const QUARANTINE_MARKER = '.torifune-quarantine';

export function pluginsDir(): string {
  const configured = process.env['TORIFUNE_PLUGINS_DIR'];
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  // apps/web/src/plugin → リポジトリルート
  return join(import.meta.dirname, '..', '..', '..', '..', 'plugins');
}

export function pluginDir(pluginId: string): string {
  return join(pluginsDir(), pluginId);
}

export function quarantineMarkerPath(pluginId: string): string {
  return join(pluginDir(pluginId), QUARANTINE_MARKER);
}
