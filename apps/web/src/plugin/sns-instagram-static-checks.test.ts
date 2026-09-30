import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';
import { GRAPH_API_VERSION } from '../../../../plugins/sns-instagram/graph';

/**
 * Instagram 配信 Plugin の静的検査（038-sns-instagram 設計 §10）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `sns-bluesky-static-checks.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件：#1（`index.ts` の形）、#2〜#11、#92、#93、#96、#97（E 側）。
 *
 * > **「無いこと」を見る検査は、実装が無いうちは素通りする**（実装プラン §7 の 2）。
 * > 判別力が付くのは実装が入った後なので、**T24 で全件そろえて走らせる**。
 */

const PLUGIN_ID = 'sns-instagram';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', PLUGIN_ID);
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const E2E_DIR = join(REPO_ROOT, 'apps', 'web', 'e2e');

function read(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8');
}

/** `plugins/sns-instagram/**\/*.ts` の一覧（`sns-bluesky-static-checks.test.ts` の写し）。 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

function pluginSources(): readonly { readonly path: string; readonly source: string }[] {
  return sourceFiles(PLUGIN_DIR).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
}

/**
 * `globalThis.fetch` と**裸の** `fetch(` の出現位置。
 *
 * `impl(url, init)` のように変数越しに呼ぶ形は数えない（実装プラン §7 の 1）。
 * `` `fetch` `` のような文中の言及や `options.fetch` も数えない（`fetch(` の綴りではないため）。
 */
function fetchOccurrences(source: string): readonly number[] {
  const found: number[] = [];
  for (const match of source.matchAll(/globalThis\.fetch|(?<![.\w])fetch\s*\(/g)) {
    found.push(match.index);
  }
  return found;
}

function lineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('#1 index.ts は既定の fetch・時計・待ちを使う', () => {
  it('#1 createInstagramPublisher を引数なしで呼ぶ', () => {
    // **本番の経路が既定を通ることを固定する**（設計 §10.1 の 1）。
    // ここで `fetch` を渡せるようにすると、差し替えが本番へ漏れる口ができる。
    const source = read('index.ts');
    const calls = [...source.matchAll(/createInstagramPublisher\(([^)]*)\)/g)];

    expect(calls, 'index.ts が createInstagramPublisher を呼んでいない').toHaveLength(1);
    expect(calls[0]?.[1]?.trim()).toBe('');
  });

  it('#1 createInstagramPublisher の引数はすべて任意（既定値つき）', () => {
    const source = read('social.ts');

    expect(source).toMatch(
      /export function createInstagramPublisher\(\s*options: InstagramPublisherOptions = \{\},?\s*\)/,
    );
  });
});

describe('#2 外部への HTTP は graph.ts に閉じている', () => {
  it('#2 graph.ts 以外のファイルに globalThis.fetch / fetch( が 1 件も無い', () => {
    for (const { path, source } of pluginSources()) {
      if (basename(path) === 'graph.ts') continue;

      expect(fetchOccurrences(source), path).toHaveLength(0);
    }
  });

  it('#2 graph.ts の出現は既定値の解決（FetchImpl と resolveFetch()）に閉じている', () => {
    // 呼び出し側は `impl(url, init)`。**`fetch(` の綴りを増やさない**（実装プラン §7 の 1）。
    const source = read('graph.ts');
    const start = source.indexOf('export function resolveFetch');
    const end = source.indexOf('\n}', start);

    expect(start, 'resolveFetch が無い').toBeGreaterThan(-1);
    const found = fetchOccurrences(source);
    expect(found.length).toBeGreaterThan(0);
    for (const index of found) {
      const inResolveFetch = index > start && index < end;
      const inTypeAlias = lineAt(source, index).includes('FetchImpl');

      expect(
        inResolveFetch || inTypeAlias,
        `既定値の解決の外に fetch がある: ${lineAt(source, index).trim()}`,
      ).toBe(true);
    }
  });
});

describe('#3 caption.ts と token.ts は純関数だけ', () => {
  const PURE_FILES = ['caption.ts', 'token.ts'] as const;

  it.each(PURE_FILES)('#3 %s は @torifune/plugin-api を型としてしか import しない', (name) => {
    const source = read(name);

    for (const match of source.matchAll(/^import\s+([^\n]*?)\s+from\s+'([^']+)';$/gm)) {
      const [, clause, specifier] = match;
      if (specifier === '@torifune/plugin-api') {
        expect(clause, `${name}: ${match[0]}`).toMatch(/^type\s/);
      }
    }
  });

  it.each(PURE_FILES)('#3 %s は fetch を持ち込まない', (name) => {
    const source = read(name);

    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toContain('globalThis.fetch');
    expect(source).not.toMatch(/from\s+'\.\/(social|graph)'/);
  });

  it.each(PURE_FILES)('#3 %s は時計を持たない（Date.now / 引数なしの new Date()）', (name) => {
    // 時刻は引数で受ける（設計 §4）。
    const source = read(name);

    expect(source).not.toContain('Date.now');
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });
});

describe('#5 Manifest', () => {
  function manifest(): Record<string, unknown> {
    return JSON.parse(read('plugin.json')) as Record<string, unknown>;
  }

  it('#5 validateManifest に通る', () => {
    const result = validateManifest(manifest(), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('#5 id が sns-instagram で apiVersion が 1', () => {
    const raw = manifest();

    expect(raw['id']).toBe(PLUGIN_ID);
    expect(raw['apiVersion']).toBe(1);
  });

  it('#5 Permission を1つも要求しない', () => {
    // Data API を1度も呼ばない（設計 §8）。
    expect(manifest()['permissions']).toEqual([]);
  });

  it('#5 拡張点は social ちょうど（ui を含まない）', () => {
    // 使わない拡張点を宣言しない（設計 §8.1）。
    expect(manifest()['extensions']).toEqual(['social']);
  });

  it('#5 拡張点は PLUGIN_EXTENSION_KINDS にある値だけ', () => {
    for (const kind of manifest()['extensions'] as string[]) {
      expect(PLUGIN_EXTENSION_KINDS as readonly string[], kind).toContain(kind);
    }
  });
});

describe('#4 環境変数を読まない', () => {
  it('#4 plugins/sns-instagram に process.env が無い', () => {
    // 設定も持たない（設計 §5.3）。環境変数へ口を増やさない。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toContain('process.env');
    }
  });
});

describe('#6 本体へ手を伸ばさない', () => {
  it('#6 @/ や apps/web を import しない', () => {
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"]@\//);
      expect(source, path).not.toMatch(/from\s+['"].*apps\/web/);
      expect(source, path).not.toMatch(/require\(['"]@\//);
      expect(source, path).not.toMatch(/import\(['"]@\//);
    }
  });

  it('#6 pg / kysely / react を import しない', () => {
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"](pg|kysely|react)['"]/);
    }
  });

  it('#6 import 先は @torifune/plugin-api と同じ Plugin のファイル（./）だけ', () => {
    for (const { path, source } of pluginSources()) {
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        expect(
          specifier === '@torifune/plugin-api' || /^\.\/[\w-]+$/.test(specifier),
          `${path}: ${specifier}`,
        ).toBe(true);
      }
    }
  });
});

describe('#7 console・Key-Value Store・画面・Data API に触れない', () => {
  it.each([
    ['console.', /console\./],
    ['context.store', /context\.store/],
    ['context.ui', /context\.ui/],
    ['context.data', /context\.data/],
    ['store.', /(?<![\w])store\./],
  ])('#7 plugins/sns-instagram に %s が無い', (_label, pattern) => {
    // 状態を 1 つも持たない（設計 §5.3）。出力は `PublishInput.logger` だけ（設計 §4）。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(pattern);
    }
  });
});

describe('#8 生成された登録簿', () => {
  it('#8 generated-registry.ts に sns-instagram の行がある', () => {
    // `pnpm generate:plugins` の出力。**Git 管理外で、手では書かない。**
    const source = readFileSync(join(import.meta.dirname, 'generated-registry.ts'), 'utf8');

    expect(source).toContain(`plugins/${PLUGIN_ID}/index`);
    expect(source).toContain(`directory: "${PLUGIN_ID}"`);
  });
});

describe('#9 README', () => {
  const readme = (): string => read('README.md');

  it.each(['プロアカウント', '60日', 'unknown', 'JPEG', '動画', '手動投稿', '約24時間', 'link'])(
    '#9 README に「%s」が現れる',
    (word) => {
      expect(readme()).toContain(word);
    },
  );

  it('#9 公開数の上限の具体的な数値を書かない', () => {
    // **公開されている値は変わる**（設計 §11 #7）。書くと README が嘘になる。
    expect(readme()).not.toMatch(/\d+\s*(件|回|投稿|posts?)\s*\/\s*(24\s*時間|日|day)/i);
    expect(readme()).not.toMatch(/(24\s*時間|1\s*日)(あたり|に)\s*\d+\s*(件|回|投稿)/);
  });
});

describe('#10 Graph API の版', () => {
  it('#10 GRAPH_API_VERSION は v＋数字＋.＋数字', () => {
    expect(GRAPH_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it('#10 GRAPH_API_VERSION の定義は graph.ts の 1 か所だけ', () => {
    const definitions = pluginSources().flatMap(({ path, source }) =>
      [...source.matchAll(/GRAPH_API_VERSION\s*=/g)].map(() => basename(path)),
    );

    expect(definitions).toEqual(['graph.ts']);
  });

  it('#10 README に同じ値が書かれている', () => {
    expect(read('README.md')).toContain(GRAPH_API_VERSION);
  });
});

describe('#11 宛先の定数は 1 か所', () => {
  it('#11 graph.instagram.com が graph.ts 以外の .ts に現れない', () => {
    // テストは宛先を書かざるを得ないので、対象は Plugin の .ts（実装プラン §8 の 7）。
    for (const { path, source } of pluginSources()) {
      if (basename(path) === 'graph.ts') continue;

      expect(source, path).not.toContain('graph.instagram.com');
    }
  });

  it('#11 graph.ts の中でも定数の定義 1 行だけ', () => {
    const source = read('graph.ts');
    const lines = source.split('\n').filter((line) => line.includes('graph.instagram.com'));

    expect(lines).toEqual(["export const GRAPH_API_BASE_URL = 'https://graph.instagram.com';"]);
  });
});

describe('#92 既存の Plugin の検査を壊さない', () => {
  it('#92 plugins/ に example-plugin・sns-bluesky・sns-instagram が並ぶ', () => {
    const directories = readdirSync(PLUGINS_DIR).filter((name) =>
      statSync(join(PLUGINS_DIR, name)).isDirectory(),
    );

    expect(directories).toContain('example-plugin');
    expect(directories).toContain('sns-bluesky');
    expect(directories).toContain(PLUGIN_ID);
  });

  it.each(['example-plugin.integration.test.ts', 'sns-bluesky-static-checks.test.ts'])(
    '#92 %s は sns-instagram を知らない（変更なしで通ることが条件）',
    (name) => {
      const source = readFileSync(join(import.meta.dirname, name), 'utf8');

      expect(source).not.toContain(PLUGIN_ID);
    },
  );
});

describe('#93 E2E は sns-instagram を導入も有効化もしない', () => {
  function specFiles(): readonly string[] {
    return readdirSync(E2E_DIR).filter((name) => name.endsWith('.spec.ts'));
  }

  it('#93 E2E の spec が 1 本以上ある', () => {
    expect(specFiles().length).toBeGreaterThan(0);
  });

  it('#93 どの spec にも sns-instagram という文字列が現れない', () => {
    // 導入・有効化の導線が spec に無い＝**外部への通信が 1 本も出ない**。
    // `/plugins` の表示（#95）は Manifest の `name`（「Instagram配信」）で見る。
    for (const name of specFiles()) {
      expect(readFileSync(join(E2E_DIR, name), 'utf8'), name).not.toContain(PLUGIN_ID);
    }
  });
});

describe('#96 sns-bluesky の静的検査は plugins/ を件数でなく名前で見る', () => {
  const source = (): string =>
    readFileSync(join(import.meta.dirname, 'sns-bluesky-static-checks.test.ts'), 'utf8');

  it('#96 plugins/ のディレクトリを toContain で見ている', () => {
    expect(source()).toMatch(/expect\(directories\)\.toContain\(/);
  });

  it('#96 plugins/ のディレクトリを件数（toHaveLength / toEqual）で見ていない', () => {
    // 件数で見ていると、3 つ目の Plugin を置いただけで落ちる。
    expect(source()).not.toMatch(/expect\(directories\)\.(toHaveLength|toEqual|toStrictEqual)\(/);
  });

  it('#96 単体テストの本数の検査は sns-bluesky で始まるファイルだけを数える', () => {
    // `sns-instagram*.test.ts` を足しても「3 本ちょうど」が落ちない。
    expect(source()).toMatch(/name\.startsWith\(`\$\{PLUGIN_ID\}`\)/);
  });
});

/**
 * #97（E 側）。**本物の `fetch` を呼んだら落ちる仕掛けが、すべてのテストファイルにあること。**
 *
 * 数を固定しておかないと、ファイルが 1 本も無くても下の検査が素通りする（実装プラン §8 の 10）。
 */
describe('#97 テストは本物の fetch を外へ出さない', () => {
  const SELF = basename(import.meta.filename);

  function testFiles(): readonly string[] {
    return readdirSync(import.meta.dirname).filter(
      (name) => name.startsWith(PLUGIN_ID) && name.endsWith('.test.ts') && name !== SELF,
    );
  }

  function unitTestFiles(): readonly string[] {
    return testFiles().filter((name) => !name.endsWith('.integration.test.ts'));
  }

  function sourceOf(name: string): string {
    return readFileSync(join(import.meta.dirname, name), 'utf8');
  }

  it('#97 対象の単体テストが 4 本ある', () => {
    expect([...unitTestFiles()].sort()).toEqual([
      'sns-instagram-conformance.test.ts',
      'sns-instagram-publish.test.ts',
      'sns-instagram-retry.test.ts',
      'sns-instagram.test.ts',
    ]);
  });

  it('#97 対象の結合テストが 1 本ある', () => {
    expect(testFiles().filter((name) => name.endsWith('.integration.test.ts'))).toEqual([
      'sns-instagram.integration.test.ts',
    ]);
  });

  it('#97 単体テストはすべて beforeEach で globalThis.fetch を「呼ばれたら投げる」に置き換える', () => {
    for (const name of unitTestFiles()) {
      const source = sourceOf(name);

      expect(source, name).toMatch(
        /beforeEach\(\(\)\s*=>\s*\{[\s\S]{0,300}?globalThis\.fetch\s*=\s*\(\(\)[\s\S]{0,200}?throw new Error\(/,
      );
    }
  });

  it('#97 単体テストはすべて afterEach で元の fetch へ戻す', () => {
    // 戻し忘れると、後続のテストファイルが道連れになる。
    for (const name of unitTestFiles()) {
      expect(sourceOf(name), name).toMatch(
        /afterEach\(\(\)\s*=>\s*\{[\s\S]{0,200}?globalThis\.fetch\s*=/,
      );
    }
  });

  it('#97 結合テストは beforeEach で「呼ばれたら投げる」fetch を置き、afterEach で戻す', () => {
    const source = sourceOf(`${PLUGIN_ID}.integration.test.ts`);

    expect(source).toMatch(/beforeEach\([\s\S]{0,400}?globalThis\.fetch\s*=\s*throwingFetch\(\)/);
    expect(source).toMatch(/throwingFetch[\s\S]{0,200}?throw new Error\(/);
    expect(source).toMatch(/afterEach\([\s\S]{0,400}?globalThis\.fetch\s*=\s*realFetch/);
  });

  it('#97 ループバックの検査は本物の fetch を読み込み時に退避し、ラッパ越しにだけ使う', () => {
    // 本物の `fetch` を `publish()` へ直に渡していない（#98 のラッパを通す）。
    const source = sourceOf(`${PLUGIN_ID}-conformance.test.ts`);

    expect(source).toMatch(/^const nativeFetch: typeof globalThis\.fetch = globalThis\.fetch;$/m);
    expect(source).not.toMatch(/createInstagramPublisher\(\{\s*fetch:\s*nativeFetch/);
  });
});
