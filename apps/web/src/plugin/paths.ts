import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `plugins/` の場所。
 *
 * ビルド時の生成スクリプトと実行時のアプリが**同じ場所**を見る必要がある。
 * 別々に組み立てると、片方だけ直したときに静かにずれる。
 *
 * **`import.meta.dirname` は本番ビルドでは使えない。**
 * Next.js のサーバーバンドルでは `undefined` になり、`join()` が投げる。
 * dev と Vitest では値が入るため、これは**本番のコンテナでだけ起きる**。
 * 実際に `012-plugin-manager` の実機確認で、Plugin Package の導入が
 * 「Plugin を配置できなかった」で失敗して見つかった。
 */

/** 隔離マーク。これがあるディレクトリはビルド時に読み込まない。 */
export const QUARANTINE_MARKER = '.torifune-quarantine';

export interface PluginsDirInput {
  /** `TORIFUNE_PLUGINS_DIR`。設定されていれば最優先。 */
  readonly configured: string | undefined;
  /** `import.meta.dirname`。本番ビルドでは `undefined`。 */
  readonly dirname: string | undefined;
  readonly cwd: string;
  readonly exists: (path: string) => boolean;
}

/**
 * 解決の本体。**環境から切り離してテストできるようにしてある。**
 *
 * `import.meta.dirname` が無いときの経路は、テスト環境では再現できない
 * （Vitest では値が入る）。切り出さなければ検査できない。
 */
export function resolvePluginsDir(input: PluginsDirInput): string {
  if (input.configured !== undefined && input.configured !== '') {
    return input.configured;
  }

  if (input.dirname !== undefined && input.dirname !== '') {
    // apps/web/src/plugin → リポジトリルート
    return join(input.dirname, '..', '..', '..', '..', 'plugins');
  }

  // アプリは `pnpm --filter @torifune/web ...` で起動するため、
  // 実行時の cwd は apps/web になる。
  const fromApp = join(input.cwd, '..', '..', 'plugins');
  if (input.exists(fromApp)) {
    return fromApp;
  }

  // リポジトリルートから直接動かした場合。
  return join(input.cwd, 'plugins');
}

export function pluginsDir(): string {
  return resolvePluginsDir({
    configured: process.env['TORIFUNE_PLUGINS_DIR'],
    // 本番ビルドでは undefined になる。型の上では string なので明示的に扱う。
    dirname: (import.meta as { dirname?: string }).dirname,
    cwd: process.cwd(),
    exists: existsSync,
  });
}

export function pluginDir(pluginId: string): string {
  return join(pluginsDir(), pluginId);
}

export function quarantineMarkerPath(pluginId: string): string {
  return join(pluginDir(pluginId), QUARANTINE_MARKER);
}
