import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';
import { THREADS_API_VERSION } from '../../../../plugins/sns-threads/threads-api';

/**
 * Threads 配信 Plugin の静的検査（040-sns-threads 設計 §8.1 / §10.1 / §10.2 / §10.15 / §10.16）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `sns-instagram-static-checks.test.ts` / `sns-x-static-checks.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件：#1（`index.ts` の形と Options のキー）、#2〜#13、#102（E 側）、#104、#107（E 側）。
 * #106（Core に差分が無いこと）は親ブランチとの `git diff` で確かめる（実装プラン §8 の 6。ここには置かない）。
 *
 * > **「無いこと」を見る検査は、実装が無いうちは素通りする**（`036` 実装プラン §7 の 2）。
 * > 実装が入った後の T28 で全件をそろえて走らせ、禁止の綴りを 1 つ足した写しで落ちることを確かめる。
 */

const PLUGIN_ID = 'sns-threads';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', PLUGIN_ID);
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const E2E_DIR = join(REPO_ROOT, 'apps', 'web', 'e2e');

function read(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8');
}

function manifest(): Record<string, unknown> {
  return JSON.parse(read('plugin.json')) as Record<string, unknown>;
}

/** `dir` 配下のファイルを再帰で集める。 */
function filesUnder(dir: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path, pattern));
    } else if (pattern.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** `plugins/sns-threads/**\/*.ts` の中身。 */
function pluginSources(): readonly { readonly path: string; readonly source: string }[] {
  return filesUnder(PLUGIN_DIR, /\.tsx?$/).map((path) => ({
    path,
    source: readFileSync(path, 'utf8'),
  }));
}

/**
 * `globalThis.fetch` と**裸の** `fetch(` の出現位置（`sns-instagram-static-checks.test.ts` の写し）。
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

/** `start` から始まる宣言の本体の範囲（最初に現れる行頭の `}` まで）。 */
function blockRange(
  source: string,
  start: number,
): { readonly start: number; readonly end: number } {
  return { start, end: source.indexOf('\n}', start) };
}

/** import / export-from 文（複数行を含む）の一覧。`typeOnly` は `import type` / `export type` か。 */
function importStatements(
  source: string,
): readonly { readonly text: string; readonly specifier: string; readonly typeOnly: boolean }[] {
  const found: { text: string; specifier: string; typeOnly: boolean }[] = [];
  for (const match of source.matchAll(
    /^(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"];?$/gm,
  )) {
    found.push({ text: match[0], specifier: match[3] ?? '', typeOnly: match[2] !== undefined });
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* §10.1 テストのための口                                                         */
/* -------------------------------------------------------------------------- */

describe('#1 index.ts は既定の fetch・時計・待ちを使う', () => {
  it('#1 createThreadsPublisher を引数なしで 1 回だけ呼ぶ', () => {
    // **本番の経路が既定を通ることを固定する**（設計 §10.1 の 1）。
    // ここで `fetch` を渡せるようにすると、差し替えが本番へ漏れる口ができる。
    const source = read('index.ts');
    const calls = [...source.matchAll(/createThreadsPublisher\(([^)]*)\)/g)];

    expect(calls, 'index.ts が createThreadsPublisher を呼んでいない').toHaveLength(1);
    expect(calls[0]?.[1]?.trim()).toBe('');
  });

  it('#1 createThreadsPublisher の引数はすべて任意（既定値つき）', () => {
    expect(read('social.ts')).toMatch(
      /export function createThreadsPublisher\(\s*options: ThreadsPublisherOptions = \{\},?\s*\)/,
    );
  });

  it('#1 ThreadsPublisherOptions のキーは fetch / now / wait のちょうど 3 つで、すべて任意', () => {
    // **`store` を受け取らない**（状態を持たない。設計 §5.3 / §10.1）。
    const source = read('social.ts');
    const start = source.indexOf('export interface ThreadsPublisherOptions');
    expect(start, 'ThreadsPublisherOptions が無い').toBeGreaterThan(-1);
    const { end } = blockRange(source, start);
    const body = source.slice(start, end);

    const keys = [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)(\??)\s*:/gm)].map((match) => ({
      key: match[1],
      optional: match[2] === '?',
    }));
    expect(keys.map((entry) => entry.key).sort()).toEqual(['fetch', 'now', 'wait']);
    for (const entry of keys) {
      expect(entry.optional, `${entry.key ?? ''} が任意でない`).toBe(true);
    }
  });
});

describe('#2 外部への HTTP は threads-api.ts に閉じている', () => {
  it('#2 threads-api.ts 以外のファイルに globalThis.fetch / fetch( が 1 件も無い', () => {
    for (const { path, source } of pluginSources()) {
      if (basename(path) === 'threads-api.ts') continue;

      expect(fetchOccurrences(source), path).toHaveLength(0);
    }
  });

  it('#2 threads-api.ts の出現は既定値の解決（FetchImpl の型と resolveFetch()）に閉じている', () => {
    // 呼び出し側は `impl(url, init)`。**`fetch(` の綴りを増やさない**（実装プラン §7 の 1）。
    const source = read('threads-api.ts');
    const start = source.indexOf('export function resolveFetch');
    expect(start, 'resolveFetch が無い').toBeGreaterThan(-1);
    const { end } = blockRange(source, start);

    const found = fetchOccurrences(source);
    expect(found.length).toBeGreaterThan(0);
    for (const index of found) {
      const inResolveFetch = index > start && index < end;
      const inTypeAlias = /^export type FetchImpl\s*=/.test(lineAt(source, index));

      expect(
        inResolveFetch || inTypeAlias,
        `既定値の解決の外に fetch がある: ${lineAt(source, index).trim()}`,
      ).toBe(true);
    }
  });
});

describe('#3 threads-text.ts と token.ts は純関数だけ', () => {
  const PURE_FILES = ['threads-text.ts', 'token.ts'] as const;

  it.each(PURE_FILES)('#3 %s は @torifune/plugin-api を型としてしか import しない', (name) => {
    for (const statement of importStatements(read(name))) {
      if (statement.specifier === '@torifune/plugin-api') {
        expect(statement.typeOnly, `${name}: ${statement.text}`).toBe(true);
      }
    }
  });

  it.each(PURE_FILES)('#3 %s は fetch を持ち込まない', (name) => {
    const source = read(name);

    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toContain('globalThis.fetch');
    // HTTP を持つファイルを経由して持ち込むこともしない。
    expect(source).not.toMatch(/from\s+['"]\.\/(social|threads-api)['"]/);
  });

  it.each(PURE_FILES)('#3 %s は時計を持たない（Date.now / 引数なしの new Date()）', (name) => {
    // 時刻は引数で受ける（設計 §4）。
    const source = read(name);

    expect(source).not.toContain('Date.now');
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });
});

describe('#4 環境変数を読まない', () => {
  it('#4 plugins/sns-threads の .ts に process.env が無い', () => {
    // 設定も持たない（設計 §5.3）。環境変数へ口を増やさない。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toContain('process.env');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §10.2 Manifest と境界                                                          */
/* -------------------------------------------------------------------------- */

describe('#5 Manifest', () => {
  it('#5 validateManifest に通る', () => {
    const result = validateManifest(manifest(), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('#5 id が sns-threads、name が Threads配信、apiVersion が 1', () => {
    const raw = manifest();

    expect(raw['id']).toBe(PLUGIN_ID);
    expect(raw['name']).toBe('Threads配信');
    expect(raw['apiVersion']).toBe(1);
  });

  it('#5 Permission を 1 つも要求しない', () => {
    // Data API を 1 度も呼ばない（設計 §8）。
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

  it('#5 dependencies を持たない', () => {
    // 他の Plugin を知らない（設計 §4.1）。
    expect('dependencies' in manifest()).toBe(false);
  });
});

describe('#6 Manifest の name と description に他の Plugin の名前が無い', () => {
  // 既存の E2E は /plugins の行を Manifest の name で絞る。Threads の行の文言に他の名前が入ると、
  // 既存のロケータが 2 行に当たって strict mode で落ちる（設計 §8.1 / #105）。
  it.each(['Bluesky配信', 'Instagram配信', 'X配信', 'Instagram'])(
    '#6 name に「%s」が現れない',
    (word) => {
      expect(String(manifest()['name'])).not.toContain(word);
    },
  );

  it.each(['Bluesky配信', 'Instagram配信', 'X配信', 'Instagram'])(
    '#6 description に「%s」が現れない',
    (word) => {
      expect(String(manifest()['description'])).not.toContain(word);
    },
  );

  it('#6 description は空でない（検査が素通りしないための前提）', () => {
    expect(typeof manifest()['description']).toBe('string');
    expect(String(manifest()['description']).trim().length).toBeGreaterThan(0);
  });
});

describe('#7 本体・DB・他の Plugin へ手を伸ばさない', () => {
  it('#7 走査の対象がある（検査が素通りしないための前提）', () => {
    const names = pluginSources().map(({ path }) => basename(path));

    for (const name of ['index.ts', 'social.ts', 'threads-api.ts', 'threads-text.ts', 'token.ts']) {
      expect(names).toContain(name);
    }
  });

  it('#7 @/ や apps/web を import しない', () => {
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"]@\//);
      expect(source, path).not.toMatch(/from\s+['"][^'"]*apps\/web/);
      expect(source, path).not.toMatch(/require\(\s*['"]/);
      expect(source, path).not.toMatch(/import\(\s*['"]/);
    }
  });

  it('#7 pg / kysely / react / node: を import しない', () => {
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"](pg|kysely|react)(\/[^'"]*)?['"]/);
      // `import 'node:…'`（from の無い形）も拾う。
      expect(source, path).not.toMatch(/['"]node:/);
    }
  });

  it('#7 他の Plugin のディレクトリ（../sns-instagram など）を指す import が 0 件', () => {
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"]\.\.\//);
    }
  });

  it('#7 import 先は @torifune/plugin-api と同じ Plugin のファイル（./）だけ', () => {
    // Plugin 全体で 1 本も拾えないなら、検査の正規表現が壊れている（import を持たないファイルはありうる）。
    expect(
      pluginSources().flatMap(({ source }) => importStatements(source)).length,
    ).toBeGreaterThan(0);
    for (const { path, source } of pluginSources()) {
      for (const { specifier } of importStatements(source)) {
        expect(
          specifier === '@torifune/plugin-api' || /^\.\/[\w-]+$/.test(specifier),
          `${path}: ${specifier}`,
        ).toBe(true);
      }
      // 行の途中の `from '…'`（正規表現が拾えない形）も同じ規則に従う。
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

describe('#8 console・Key-Value Store・画面・Data API に触れない', () => {
  it.each([
    ['console.', /console\./],
    ['context.store', /context\.store/],
    ['context.ui', /context\.ui/],
    ['context.data', /context\.data/],
    ['store.', /(?<![\w])store\./],
  ])('#8 plugins/sns-threads に %s が無い', (_label, pattern) => {
    // 状態を 1 つも持たない（設計 §5.3）。出力は `PublishInput.logger` だけ（設計 §4）。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(pattern);
    }
  });
});

describe('#9 生成された登録簿', () => {
  it('#9 generated-registry.ts に sns-threads の行がある', () => {
    // `pnpm generate:plugins` の出力。**Git 管理外で、手では書かない。**
    // `lint` / `typecheck` が通ることは T29 のコマンドで確かめる。
    const source = readFileSync(join(import.meta.dirname, 'generated-registry.ts'), 'utf8');

    expect(source).toContain(`plugins/${PLUGIN_ID}/index`);
    expect(source).toContain(`directory: "${PLUGIN_ID}"`);
  });
});

describe('#10 Threads API の版', () => {
  it('#10 THREADS_API_VERSION は v＋数字＋.＋数字', () => {
    expect(THREADS_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it('#10 THREADS_API_VERSION の定義は threads-api.ts の 1 か所だけ', () => {
    const definitions = pluginSources().flatMap(({ path, source }) =>
      [...source.matchAll(/THREADS_API_VERSION\s*=/g)].map(() => basename(path)),
    );

    expect(definitions).toEqual(['threads-api.ts']);
  });

  it('#10 README に同じ値が書かれている', () => {
    // 版を上げたら README も同時に直す（設計 §6.1）。
    expect(read('README.md')).toContain(THREADS_API_VERSION);
  });
});

describe('#11 宛先の定数は 1 か所', () => {
  // テストは宛先を書かざるを得ないので、対象は Plugin の .ts（README を除く。設計 #11）。
  it('#11 graph.threads.net が threads-api.ts 以外の .ts に現れない', () => {
    for (const { path, source } of pluginSources()) {
      if (basename(path) === 'threads-api.ts') continue;

      expect(source, path).not.toContain('graph.threads.net');
    }
  });

  it('#11 threads-api.ts の中でも graph.threads.net は定数の定義 1 行だけ', () => {
    const lines = read('threads-api.ts')
      .split('\n')
      .filter((line) => line.includes('graph.threads.net'));

    expect(lines).toEqual(["export const THREADS_API_BASE_URL = 'https://graph.threads.net';"]);
  });

  it('#11 threads.com/intent/post が threads-text.ts 以外の .ts に現れない', () => {
    for (const { path, source } of pluginSources()) {
      if (basename(path) === 'threads-text.ts') continue;

      expect(source, path).not.toContain('threads.com/intent/post');
    }
  });

  it('#11 threads-text.ts の中でも threads.com/intent/post は定数の定義 1 行だけ', () => {
    const lines = read('threads-text.ts')
      .split('\n')
      .filter((line) => line.includes('threads.com/intent/post'));

    expect(lines).toEqual([
      "export const THREADS_INTENT_BASE_URL = 'https://www.threads.com/intent/post';",
    ]);
  });

  it('#11 graph.threads.com はどの .ts にも現れない', () => {
    // もう一方の宛先も有効だが、使わない（設計 §6.1）。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toContain('graph.threads.com');
    }
  });
});

describe('#12 README', () => {
  const readme = (): string => read('README.md');

  it.each([
    '60日',
    'unknown',
    'JPEG',
    'PNG',
    '8MB',
    '動画',
    '手動投稿',
    '約24時間',
    '5本',
    '絵文字',
    '資格情報を設定',
    'クエリ',
  ])('#12 README に「%s」が現れる', (word) => {
    expect(readme()).toContain(word);
  });

  it('#12 README に「資格情報（アクセストークン等）」が現れない（039 #45 と同じ）', () => {
    expect(readme()).not.toContain('資格情報（アクセストークン等）');
  });

  it('#12 README に使っている宛先 graph.threads.net が書かれている（設計 §9.6）', () => {
    expect(readme()).toContain('graph.threads.net');
  });

  it('#12 公開数の上限の具体的な数値を書かない（設計 §9.6）', () => {
    // **公開されている値は変わる**。書くと README が嘘になる（038 §11 #7 と同じ）。
    expect(readme()).not.toMatch(/\d+\s*(件|回|投稿|posts?)\s*\/\s*(24\s*時間|日|day)/i);
    expect(readme()).not.toMatch(/(24\s*時間|1\s*日)\s*(あたり|に|で)\s*\d+\s*(件|回|投稿)/);
  });
});

describe('#13 認証はヘッダで渡さない', () => {
  it('#13 plugins/sns-threads の .ts に Authorization / Bearer が現れない（大文字・小文字を問わず、コメントを含む）', () => {
    // トークンは `access_token` の引数で渡す（設計 §6.2）。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/authorization/i);
      expect(source, path).not.toMatch(/bearer/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §10.15 既存への影響                                                            */
/* -------------------------------------------------------------------------- */

describe('#102 既存の Plugin の検査を壊さない', () => {
  const EXISTING_CHECKS = [
    'example-plugin.integration.test.ts',
    'sns-bluesky-static-checks.test.ts',
    'sns-instagram-static-checks.test.ts',
    'sns-x-static-checks.test.ts',
  ] as const;

  function sourceOf(name: string): string {
    return readFileSync(join(import.meta.dirname, name), 'utf8');
  }

  it('#102 plugins/ に 6 つの Plugin が並ぶ', () => {
    const directories = readdirSync(PLUGINS_DIR).filter((name) =>
      statSync(join(PLUGINS_DIR, name)).isDirectory(),
    );

    for (const name of [
      'example-plugin',
      'sns-bluesky',
      'sns-instagram',
      'sns-x-manual',
      'sns-x-api',
      PLUGIN_ID,
    ]) {
      expect(directories).toContain(name);
    }
  });

  it.each(EXISTING_CHECKS)(
    '#102 %s は sns-threads を知らない（変更なしで通ることが条件）',
    (name) => {
      expect(sourceOf(name)).not.toContain(PLUGIN_ID);
    },
  );

  it.each(EXISTING_CHECKS)(
    '#102 %s は plugins/ のディレクトリを件数（toHaveLength / toEqual / toStrictEqual）で見ていない',
    (name) => {
      // 件数で見ていると、6 つ目の Plugin を置いただけで落ちる。
      expect(sourceOf(name)).not.toMatch(
        /expect\(directories\)\.(toHaveLength|toEqual|toStrictEqual)\(/,
      );
    },
  );

  it.each(EXISTING_CHECKS)(
    '#102 %s のテストファイルの選び方が sns-threads*.test.ts を拾わない（sns / sns- で始まるかを見ていない）',
    (name) => {
      expect(sourceOf(name)).not.toMatch(/startsWith\(\s*['"`]sns-?['"`]\s*\)/);
    },
  );
});

describe('#104 E2E は sns-threads を導入も有効化もしない', () => {
  function specFiles(): readonly string[] {
    return filesUnder(E2E_DIR, /\.spec\.ts$/);
  }

  it('#104 E2E の spec が 1 本以上ある（検査が素通りしないための前提）', () => {
    expect(specFiles().length).toBeGreaterThan(0);
  });

  it('#104 apps/web/e2e/ のどの spec（再帰で）にも sns-threads という文字列が現れない', () => {
    // 導入・有効化の導線が spec に無い＝**外部への通信が 1 本も出ない**。
    // `/plugins` の表示（#103）は Manifest の `name`（「Threads配信」）で見る。
    for (const path of specFiles()) {
      expect(readFileSync(path, 'utf8'), path).not.toContain(PLUGIN_ID);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §10.16 本物の fetch を外へ出さない（E 側）                                        */
/* -------------------------------------------------------------------------- */

/**
 * #107（E 側）。**本物の `fetch` を呼んだら落ちる仕掛けが、すべてのテストファイルにあること。**
 *
 * 数を固定しておかないと、ファイルが 1 本も無くても下の検査が素通りする（実装プラン §8 の 5）。
 * 仕掛けを共有ヘルパにしないのは、この検査が各ファイルの綴りを読むため。
 */
describe('#107 sns-threads のテストは本物の fetch を外へ出さない', () => {
  const SELF = basename(import.meta.filename);

  function testFiles(): readonly string[] {
    return readdirSync(import.meta.dirname)
      .filter((name) => name.startsWith(PLUGIN_ID) && name.endsWith('.test.ts') && name !== SELF)
      .sort();
  }

  function sourceOf(name: string): string {
    return readFileSync(join(import.meta.dirname, name), 'utf8');
  }

  it('#107 対象のテストファイルがちょうど 6 本（単体 5・結合 1）', () => {
    expect(testFiles()).toEqual([
      'sns-threads-conformance.test.ts',
      'sns-threads-publish.test.ts',
      'sns-threads-retry.test.ts',
      'sns-threads-text.test.ts',
      'sns-threads.integration.test.ts',
      'sns-threads.test.ts',
    ]);
  });

  it('#107 すべてのファイルに「呼ばれたら投げる」throwingFetch がある', () => {
    for (const name of testFiles()) {
      expect(sourceOf(name), name).toMatch(
        /function throwingFetch\(\)[\s\S]{0,300}?throw new Error\(/,
      );
    }
  });

  it('#107 すべてのファイルが beforeEach で globalThis.fetch を throwingFetch() に置き換える', () => {
    for (const name of testFiles()) {
      expect(sourceOf(name), name).toMatch(
        /beforeEach\([\s\S]{0,400}?globalThis\.fetch\s*=\s*throwingFetch\(\)/,
      );
    }
  });

  it('#107 すべてのファイルが afterEach で元の fetch（realFetch）へ戻す', () => {
    // 戻し忘れると、後続のテストファイルが道連れになる。
    for (const name of testFiles()) {
      expect(sourceOf(name), name).toMatch(
        /afterEach\([\s\S]{0,400}?globalThis\.fetch\s*=\s*realFetch\b/,
      );
    }
  });

  it('#107 ループバックの検査は本物の fetch を読み込み時に realFetch として退避する', () => {
    expect(sourceOf(`${PLUGIN_ID}-conformance.test.ts`)).toMatch(
      /^const realFetch: typeof globalThis\.fetch = globalThis\.fetch;$/m,
    );
  });

  it('#107 ループバックの検査で realFetch( の呼び出しは loopbackFetch の中だけ', () => {
    // ラッパは書き換え前の URL が https://graph.threads.net/ で始まらなければ、本物を呼ばずに投げる（#107 A 側）。
    const source = sourceOf(`${PLUGIN_ID}-conformance.test.ts`);
    const start = source.indexOf('function loopbackFetch(');
    expect(start, 'loopbackFetch が無い').toBeGreaterThan(-1);
    const { end } = blockRange(source, start);

    const calls = [...source.matchAll(/(?<![.\w])realFetch\s*\(/g)].map((match) => match.index);
    expect(calls.length).toBeGreaterThan(0);
    for (const index of calls) {
      expect(index > start && index < end, lineAt(source, index).trim()).toBe(true);
    }
  });

  it('#107 ループバックの検査は本物の fetch を publish() へ直に渡さない', () => {
    expect(sourceOf(`${PLUGIN_ID}-conformance.test.ts`)).not.toMatch(
      /createThreadsPublisher\(\{[^}]*fetch:\s*(realFetch|globalThis\.fetch)\b/,
    );
  });

  it('#107 結合テストの偽 Threads API は未知の宛先で投げる見分け方（threadsRequestKind）を通す', () => {
    // 実際に投げることは結合テストの #107 が確かめる。ここでは経路を固定する。
    const source = sourceOf(`${PLUGIN_ID}.integration.test.ts`);

    expect(source).toMatch(/function useFakeThreadsApi\([\s\S]{0,800}?threadsRequestKind\(/);
  });
});
