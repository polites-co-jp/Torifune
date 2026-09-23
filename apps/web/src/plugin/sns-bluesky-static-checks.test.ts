import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * Bluesky 配信 Plugin の静的検査（036-sns-bluesky 設計 §10）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `example-plugin.integration.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件：#1（`index.ts` の形）、#2〜#8、#52（E 側）、#71、#73。
 *
 * > **「無いこと」を見る検査は、実装が無いうちは素通りする**（実装プラン §7 の 2）。
 * > 判別力が付くのは実装が入った後なので、**G5 で全件そろえて走らせる**。
 */

const PLUGIN_ID = 'sns-bluesky';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', PLUGIN_ID);
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const E2E_DIR = join(REPO_ROOT, 'apps', 'web', 'e2e');

function read(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8');
}

/** `plugins/sns-bluesky/**\/*.ts` の一覧（`example-plugin.integration.test.ts` の写し）。 */
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
 * `impl(url, init)` のように変数越しに呼ぶ形は数えない（実装プラン §8 の 1）。
 * `` `fetch` `` のような文中の言及も数えない（`fetch(` の綴りではないため）。
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

describe('#1 index.ts は既定の fetch と時刻を使う', () => {
  it('#1 createBlueskyPublisher へ store だけを渡す', () => {
    // **本番の経路が既定を通ることを固定する**（設計 §10.1 の 1）。
    // ここで `fetch` を渡せるようにすると、差し替えが本番へ漏れる口ができる。
    const source = read('index.ts');
    const match = /createBlueskyPublisher\(\{([^}]*)\}\)/.exec(source);

    expect(match, 'index.ts が createBlueskyPublisher を呼んでいない').not.toBeNull();
    expect(match?.[1] ?? '').toContain('store');
    expect(match?.[1] ?? '').not.toMatch(/(?<![.\w])fetch\b/);
    expect(match?.[1] ?? '').not.toMatch(/\bnow\b/);
  });
});

describe('#2 外部への HTTP は atproto.ts に閉じている', () => {
  /**
   * **数えるのは「`atproto.ts` 以外での出現」**（設計 §10.1 の 2、2026-09-23 の訂正）。
   *
   * `globalThis.fetch` は型宣言（`export type FetchImpl = typeof globalThis.fetch;`）と
   * 既定値の解決（`resolveFetch()`）の 2 行に現れ、設計 §10.1 の
   * `fetch?: typeof globalThis.fetch` を満たすかぎり分けられない。
   */
  it('#2 atproto.ts 以外のファイルに fetch の直接呼び出しが1件も無い', () => {
    for (const { path, source } of pluginSources()) {
      if (basename(path) === 'atproto.ts') continue;

      expect(fetchOccurrences(source), path).toHaveLength(0);
    }
  });

  it('#2 atproto.ts の出現は既定値の解決に閉じている', () => {
    // 型宣言（`FetchImpl`）と `resolveFetch()` の中だけ。**呼び出し側は `impl(url, init)`**。
    const source = read('atproto.ts');
    const start = source.indexOf('export function resolveFetch');
    const end = source.indexOf('\n}', start);

    expect(start, 'resolveFetch が無い').toBeGreaterThan(-1);
    for (const index of fetchOccurrences(source)) {
      const inResolveFetch = index > start && index < end;
      const inTypeAlias = lineAt(source, index).includes('FetchImpl');

      expect(
        inResolveFetch || inTypeAlias,
        `既定値の解決の外に fetch がある: ${lineAt(source, index).trim()}`,
      ).toBe(true);
    }
  });

  it('#2 process.env を読まない', () => {
    // 設定は Key-Value Store（`pds-url`）だけ。環境変数へ口を増やさない。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toContain('process.env');
    }
  });
});

describe('#3 text.ts は純関数だけ', () => {
  it('@torifune/plugin-api を型としてしか import しない', () => {
    const source = read('text.ts');

    for (const match of source.matchAll(/^import\s+([^\n]*?)\s+from\s+'([^']+)';$/gm)) {
      const [, clause, specifier] = match;
      if (specifier === '@torifune/plugin-api') {
        expect(clause, `text.ts: ${match[0]}`).toMatch(/^type\s/);
      }
    }
  });

  it('store や fetch を持ち込まない', () => {
    const source = read('text.ts');

    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toContain('globalThis.fetch');
    expect(source).not.toMatch(/from\s+'\.\/(settings|social|atproto)'/);
    expect(source).not.toContain('PluginStore');
  });
});

describe('#4 Manifest', () => {
  function manifest(): unknown {
    return JSON.parse(read('plugin.json'));
  }

  it('validateManifest に通る', () => {
    const result = validateManifest(manifest(), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('id が sns-bluesky で apiVersion が 1', () => {
    const raw = manifest() as Record<string, unknown>;

    expect(raw['id']).toBe(PLUGIN_ID);
    expect(raw['apiVersion']).toBe(1);
  });

  it('Permission を1つも要求しない', () => {
    // Data API を1度も呼ばない。投稿も資格情報も引数として渡ってくる（設計 §8）。
    expect((manifest() as Record<string, unknown>)['permissions']).toEqual([]);
  });

  it('拡張点は social と ui の2つ', () => {
    const extensions = (manifest() as Record<string, unknown>)['extensions'];

    expect(Array.isArray(extensions)).toBe(true);
    expect([...(extensions as string[])].sort()).toEqual(['social', 'ui']);
  });

  it('拡張点は PLUGIN_EXTENSION_KINDS にある値だけ', () => {
    // 独自の値を足すと /plugins に生の値がそのまま出る（設計 §9.1）。
    for (const kind of (manifest() as Record<string, unknown>)['extensions'] as string[]) {
      expect(PLUGIN_EXTENSION_KINDS as readonly string[], kind).toContain(kind);
    }
  });
});

describe('#5 本体へ手を伸ばさない', () => {
  it('#5 @/ や apps/web を import しない', () => {
    // 本体の内部へ手を伸ばすと、本体の再編で Plugin が壊れる。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"]@\//);
      expect(source, path).not.toMatch(/from\s+['"].*apps\/web/);
      expect(source, path).not.toMatch(/require\(['"]@\//);
    }
  });

  it('#5 Torifune のパッケージは @torifune/plugin-api だけ', () => {
    for (const { path, source } of pluginSources()) {
      for (const match of source.matchAll(/from\s+['"](@torifune\/[^'"]+)['"]/g)) {
        expect(match[1], path).toBe('@torifune/plugin-api');
      }
    }
  });

  it('#5 pg / kysely / react を import しない', () => {
    // データベースへ直接 SQL を発行しない。画面部品も持たない（設計 §4）。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/from\s+['"](pg|kysely|react)['"]/);
    }
  });
});

describe('#6 console を使わない', () => {
  it('#6 plugins/sns-bluesky に console. が無い', () => {
    // 出力は `context.logger` / `PublishInput.logger` だけ（リポジトリの ESLint も全域で禁じている）。
    for (const { path, source } of pluginSources()) {
      expect(source, path).not.toMatch(/console\./);
    }
  });
});

describe('#7 生成された登録簿', () => {
  it('#7 generated-registry.ts に sns-bluesky の行がある', () => {
    // `pnpm generate:plugins` の出力。**Git 管理外で、手では書かない。**
    const source = readFileSync(join(import.meta.dirname, 'generated-registry.ts'), 'utf8');

    expect(source).toContain(`plugins/${PLUGIN_ID}/index`);
    expect(source).toContain(`directory: "${PLUGIN_ID}"`);
  });
});

describe('#8 README', () => {
  const readme = (): string => read('README.md');

  it('#8 App Password がログインパスワードではないと書いてある', () => {
    // **ここに書かないと、利用者はログインパスワードを入れる**（設計 §5.1）。
    const source = readme();

    // 文言は設計 §5.1 の `description` に合わせる（「ログインする／ログイン用の」の両方を許す）。
    expect(source).toContain('App Password');
    expect(source).toMatch(/ログイン(する|用の)パスワード(ではありません|を(ここへ)?入れないで)/);
  });

  it('#8 約24時間で failed になると書いてある', () => {
    // 035 裁定 #9。資格情報を入れないまま放置した投稿は終端へ落ちる。
    const source = readme();

    expect(source).toContain('24時間');
    expect(source).toContain('failed');
  });

  it('#8 本文は300文字までと書いてある', () => {
    expect(readme()).toContain('300文字');
  });

  it('#8 画像は4枚までと書いてある', () => {
    expect(readme()).toMatch(/4枚/);
  });

  it('#8 画像とリンクカードを同時に付けられないと書いてある', () => {
    expect(readme()).toMatch(/画像とリンクカード.*同時/);
  });

  it('#8 Rate Limit の具体的な数値を書かない', () => {
    // **公開されている値は変わる**（設計 §11 #13）。書くと README が嘘になる。
    expect(readme()).not.toMatch(/\d+\s*(回|requests?)\s*\/\s*(分|時間|日|min|hour|day)/i);
  });
});

/**
 * #52（E 側）。**本物の `fetch` を呼んだら落ちる仕掛けがあること。**
 *
 * 対象は `plugins/sns-bluesky` を直接呼ぶ**単体テスト**（設計 §10 #52）。
 * 結合テスト（`*.integration.test.ts`）は Core のジョブを通すため、
 * `globalThis.fetch` を**偽の PDS**に差し替える（投げる形にはできない）。
 */
describe('#52 単体テストは本物の fetch を呼ばない', () => {
  function unitTestFiles(): readonly string[] {
    return readdirSync(import.meta.dirname).filter(
      (name) =>
        name.startsWith(`${PLUGIN_ID}`) &&
        name.endsWith('.test.ts') &&
        !name.endsWith('.integration.test.ts') &&
        name !== basename(import.meta.filename),
    );
  }

  it('#52 対象の単体テストが3本ある', () => {
    // 数を固定しておかないと、ファイルが1本も無くても下の検査が素通りする。
    expect([...unitTestFiles()].sort()).toEqual([
      'sns-bluesky-publish.test.ts',
      'sns-bluesky-retry.test.ts',
      'sns-bluesky.test.ts',
    ]);
  });

  it('#52 すべてが globalThis.fetch を「呼ばれたら投げる」に置き換えている', () => {
    for (const name of unitTestFiles()) {
      const source = readFileSync(join(import.meta.dirname, name), 'utf8');

      expect(source, name).toMatch(/beforeEach\(/);
      expect(source, name).toMatch(/globalThis\.fetch\s*=\s*\(\(\)[\s\S]{0,200}?throw new Error\(/);
    }
  });

  it('#52 すべてが afterEach で元の fetch へ戻す', () => {
    // 戻し忘れると、後続のテストファイルが道連れになる。
    for (const name of unitTestFiles()) {
      const source = readFileSync(join(import.meta.dirname, name), 'utf8');

      expect(source, name).toMatch(/afterEach\(\(\)\s*=>\s*\{[\s\S]*globalThis\.fetch\s*=/);
    }
  });
});

describe('#71 既存の Plugin の検査を壊さない', () => {
  it('#71 plugins/ に example-plugin と sns-bluesky が並ぶ', () => {
    const directories = readdirSync(PLUGINS_DIR).filter((name) =>
      statSync(join(PLUGINS_DIR, name)).isDirectory(),
    );

    expect(directories).toContain('example-plugin');
    expect(directories).toContain(PLUGIN_ID);
  });

  it('#71 example-plugin の検査は sns-bluesky を知らない', () => {
    // **変更しないこと自体が受け入れ条件**である（設計 §10 #71）。
    const source = readFileSync(
      join(import.meta.dirname, 'example-plugin.integration.test.ts'),
      'utf8',
    );

    expect(source).not.toContain(PLUGIN_ID);
  });

  it('#71 example-plugin の検査は件数ではなく id で引いている', () => {
    // 件数に依存していると、Plugin が2件になっただけで落ちる。
    const source = readFileSync(
      join(import.meta.dirname, 'example-plugin.integration.test.ts'),
      'utf8',
    );

    expect(source).toMatch(/discoverPlugins\(\)\.plugins\.find\(/);
  });
});

describe('#73 E2E は sns-bluesky を導入も有効化もしない', () => {
  function specFiles(): readonly string[] {
    return readdirSync(E2E_DIR).filter((name) => name.endsWith('.spec.ts'));
  }

  it('#73 E2E の spec が1本以上ある', () => {
    expect(specFiles().length).toBeGreaterThan(0);
  });

  it('#73 どの spec にも sns-bluesky という文字列が現れない', () => {
    // 導入・有効化の導線が spec に無い＝**外部への通信が1本も出ない**。
    // `/plugins` の表示（#72）は Manifest の `name`（「Bluesky配信」）で見る。
    for (const name of specFiles()) {
      expect(readFileSync(join(E2E_DIR, name), 'utf8'), name).not.toContain(PLUGIN_ID);
    }
  });
});
