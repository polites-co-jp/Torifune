import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import {
  BUILD_CONFIG_PATH,
  CHECK_CONFIG_PATH,
  readRawConfig,
} from '@/test-support/build-typecheck';

/**
 * 本番のビルドの型検査の設定の静的検査（052-rebuild-without-tests 設計 §10.1）。
 *
 * ファイルに何が書かれているかだけを見る。プログラムは組まない。
 *
 * 担当する受け入れ条件：#1〜#6。
 * #6 の `.dockerignore` の照合は、照合そのものが見分けられることを同じファイルで確かめる（判別力）。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...segments), 'utf8')) as Record<string, unknown>;
}

function scriptsOf(...segments: string[]): Record<string, string> {
  return readJson(...segments).scripts as Record<string, string>;
}

const EXPECTED_BUILD_EXCLUDE = [
  'node_modules',
  'e2e',
  'playwright.config.ts',
  'src/test-support',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
];

describe('#1〜#2 ビルドの設定の形', () => {
  it('#1 tsconfig.build.json が誤り無く読め、トップレベルのキーは extends と exclude だけ', () => {
    const config = readRawConfig(BUILD_CONFIG_PATH);
    expect(Object.keys(config).sort()).toEqual(['exclude', 'extends']);
  });

  it('#1 tsconfig.build.json の extends は "./tsconfig.json"', () => {
    const config = readRawConfig(BUILD_CONFIG_PATH);
    expect(config.extends).toBe('./tsconfig.json');
  });

  it('#2 tsconfig.build.json の exclude は 8 つをちょうど持つ（順不同・重複なし）', () => {
    const exclude = readRawConfig(BUILD_CONFIG_PATH).exclude as unknown[];
    expect(Array.isArray(exclude)).toBe(true);
    expect(exclude).toHaveLength(EXPECTED_BUILD_EXCLUDE.length);
    expect(new Set(exclude).size).toBe(exclude.length);
    expect([...exclude].sort()).toEqual([...EXPECTED_BUILD_EXCLUDE].sort());
  });
});

describe('#3 next.config の型検査の設定', () => {
  it('#3 typescript.tsconfigPath が tsconfig.build.json を指す', () => {
    expect(nextConfig.typescript?.tsconfigPath).toBe('tsconfig.build.json');
  });

  it('#3 typescript.ignoreBuildErrors は false のまま（型の誤りでビルドを止める）', () => {
    expect(nextConfig.typescript?.ignoreBuildErrors).toBe(false);
  });
});

/**
 * `ci.yml` の `jobs:` の下の `check:` の段（次の 2 字下げのジョブ名の行の手前まで）を切り出す。
 * YAML の読み込みの依存を足さない（実装プラン §8 の 8）。
 */
function ciJobSection(ci: string, job: string): string {
  const lines = ci.split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => line === 'jobs:');
  const start = lines.findIndex((line, i) => i > jobsAt && line === `  ${job}:`);
  if (jobsAt < 0 || start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('#4〜#5 変えないもの', () => {
  it('#4 tsconfig.json の include は今のまま（テストファイルを含む）', () => {
    const config = readRawConfig(CHECK_CONFIG_PATH);
    expect(config.include).toEqual(['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts']);
  });

  it('#4 tsconfig.json の exclude は今のまま（テストファイルを外していない）', () => {
    const config = readRawConfig(CHECK_CONFIG_PATH);
    expect(config.exclude).toEqual(['node_modules', 'e2e']);
  });

  it('#5 web の typecheck は tsc --noEmit（-p・--project を持たない）', () => {
    const typecheck = scriptsOf('apps', 'web', 'package.json').typecheck;
    expect(typecheck).toBe('tsc --noEmit');
    expect(typecheck).not.toMatch(/(^|\s)(-p|--project)(\s|=|$)/);
  });

  it('#5 web の build は next build', () => {
    expect(scriptsOf('apps', 'web', 'package.json').build).toBe('next build');
  });

  it('#5 ルートの typecheck は pnpm -r typecheck', () => {
    expect(scriptsOf('package.json').typecheck).toBe('pnpm -r typecheck');
  });

  it('#5 ルートの build は pnpm generate:plugins && pnpm -r build', () => {
    expect(scriptsOf('package.json').build).toBe('pnpm generate:plugins && pnpm -r build');
  });

  it('#5 CI の check ジョブの手順に run: pnpm typecheck がある', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const check = ciJobSection(ci, 'check');
    expect(check).not.toBe('');
    expect(check.split('\n').some((line) => /^\s*- run: pnpm typecheck\s*$/.test(line))).toBe(true);
  });
});

/**
 * `.dockerignore` の 1 行をグロブとして `path` に当てる（実装プラン §8 の 7）。
 * `**` は区切りをまたぐ任意、`*` は区切りをまたがない任意、`?` は区切り以外の 1 文字。
 * 行が `path` か、その祖先のディレクトリに当たれば「当たる」（Docker はディレクトリごと外す）。
 */
function dockerignoreHits(pattern: string, path: string): boolean {
  const normalized = pattern.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized[i] as string;
    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regex = new RegExp(`^${source}$`);
  const segments = path.split('/');
  return segments.some((_, i) => regex.test(segments.slice(0, i + 1).join('/')));
}

/** 判定に使う行：`!` で始まる行・コメント・空行を除く。 */
function dockerignorePatterns(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'));
}

const BUILD_CONFIG_IN_IMAGE = 'apps/web/tsconfig.build.json';

describe('#6 イメージに入る', () => {
  it('#6 .dockerignore のどの行も apps/web/tsconfig.build.json に当たらない', () => {
    const text = readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8');
    const patterns = dockerignorePatterns(text);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.filter((pattern) => dockerignoreHits(pattern, BUILD_CONFIG_IN_IMAGE))).toEqual(
      [],
    );
  });

  it.each([
    'apps',
    'apps/web',
    'apps/web/*.json',
    '**/tsconfig.build.json',
    'apps/web/tsconfig.build.json',
    '/apps/web/tsconfig.build.json',
  ])('（判別力）照合は %s を「当たる」と判定する', (pattern) => {
    expect(dockerignoreHits(pattern, BUILD_CONFIG_IN_IMAGE)).toBe(true);
  });

  it.each(['docs', '**/node_modules', 'apps/web/src/plugin/generated-registry.ts', '.env.*'])(
    '（判別力）照合は %s を「当たらない」と判定する',
    (pattern) => {
      expect(dockerignoreHits(pattern, BUILD_CONFIG_IN_IMAGE)).toBe(false);
    },
  );

  it('（判別力）! で始まる行・コメント・空行は判定に使わない', () => {
    expect(dockerignorePatterns('# apps\n\n!apps/web/tsconfig.build.json\ndocs\n')).toEqual([
      'docs',
    ]);
  });
});
