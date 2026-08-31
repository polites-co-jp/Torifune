import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePluginsDir } from './paths';

/**
 * `plugins/` の解決。
 *
 * **本番ビルドで `import.meta.dirname` が `undefined` になる経路を検査する。**
 * dev と Vitest では値が入るため、この経路はテスト環境では再現できない。
 * `012-plugin-manager` の実機確認で、ここが原因で Plugin Package の導入が
 * 失敗していることが分かった（`03_リスクと未決事項.md` の記録を参照）。
 */

const never = (): boolean => {
  throw new Error('exists を呼んではいけない');
};

describe('pluginsDir の解決', () => {
  it('TORIFUNE_PLUGINS_DIR があればそれを使う', () => {
    expect(
      resolvePluginsDir({
        configured: '/srv/torifune/plugins',
        dirname: '/app/apps/web/src/plugin',
        cwd: '/app/apps/web',
        exists: never,
      }),
    ).toBe('/srv/torifune/plugins');
  });

  it('空文字の TORIFUNE_PLUGINS_DIR は未設定として扱う', () => {
    // 未設定のつもりで空を入れる運用があるため、空を採用すると
    // ルート直下の `plugins` を見に行くことになる。
    expect(
      resolvePluginsDir({
        configured: '',
        dirname: join('/app', 'apps', 'web', 'src', 'plugin'),
        cwd: '/app/apps/web',
        exists: never,
      }),
    ).toBe(join('/app', 'plugins'));
  });

  it('import.meta.dirname があればそこから遡る', () => {
    expect(
      resolvePluginsDir({
        configured: undefined,
        dirname: join('/app', 'apps', 'web', 'src', 'plugin'),
        cwd: '/somewhere/else',
        exists: never,
      }),
    ).toBe(join('/app', 'plugins'));
  });

  it('本番ビルドで dirname が無いとき、apps/web から起動していれば遡って解決する', () => {
    // `pnpm --filter @torifune/web start` の cwd は apps/web。
    const cwd = join('/app', 'apps', 'web');
    expect(
      resolvePluginsDir({
        configured: undefined,
        dirname: undefined,
        cwd,
        exists: (path) => path === join('/app', 'plugins'),
      }),
    ).toBe(join('/app', 'plugins'));
  });

  it('本番ビルドで dirname が無く、リポジトリルートから起動していれば直下を見る', () => {
    expect(
      resolvePluginsDir({
        configured: undefined,
        dirname: undefined,
        cwd: '/app',
        exists: () => false,
      }),
    ).toBe(join('/app', 'plugins'));
  });

  it('dirname が無くても undefined を含むパスを組み立てない', () => {
    // ここが壊れると join() が投げ、Plugin の導入が
    // 「Plugin を配置できなかった」という分かりにくい 422 になる。
    const resolved = resolvePluginsDir({
      configured: undefined,
      dirname: undefined,
      cwd: '/app/apps/web',
      exists: () => false,
    });
    expect(resolved).not.toContain('undefined');
    expect(typeof resolved).toBe('string');
  });
});
