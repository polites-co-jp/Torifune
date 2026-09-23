import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * X 配信 Plugin（`sns-x-manual` / `sns-x-api`）の静的検査（037-sns-x 設計 §10.1 / §10.2 / §10.14 / §10.15）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `sns-instagram-static-checks.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件：#1〜#9、#11、#12、#84、#85、#88、#89（E 側）、#92（E 側）。
 *
 * > **「無いこと」を見る検査は、実装が無いうちは素通りする**（`036` 実装プラン §7 の 2）。
 * > そこで #2 / #3 / #6 / #7 / #12 / #89 / #92 は、検査の述語を関数に切り出し、
 * > **禁止の綴りを 1 つ足した写し**にも同じ述語を掛けて、見分けられることを同じファイルの中で確かめる
 * > （判別力。実装プラン T24 の注意）。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const E2E_DIR = join(REPO_ROOT, 'apps', 'web', 'e2e');

const PLUGIN_IDS = ['sns-x-manual', 'sns-x-api'] as const;
type PluginId = (typeof PLUGIN_IDS)[number];

function readPlugin(id: PluginId, name: string): string {
  return readFileSync(join(PLUGINS_DIR, id, name), 'utf8');
}

function manifest(id: PluginId): Record<string, unknown> {
  return JSON.parse(readPlugin(id, 'plugin.json')) as Record<string, unknown>;
}

/** `dir` の下の `.ts` / `.tsx`（再帰）。 */
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

interface PluginSource {
  readonly id: PluginId;
  /** `plugins/` からの相対パス（例：`sns-x-api/xapi.ts`）。区切りは `/`。 */
  readonly path: string;
  readonly name: string;
  readonly source: string;
}

function pluginSources(id: PluginId): readonly PluginSource[] {
  return sourceFiles(join(PLUGINS_DIR, id)).map((path) => ({
    id,
    path: relative(PLUGINS_DIR, path).replaceAll('\\', '/'),
    name: basename(path),
    source: readFileSync(path, 'utf8'),
  }));
}

/** 2 つの Plugin の `**\/*.ts`。 */
function allSources(): readonly PluginSource[] {
  return PLUGIN_IDS.flatMap((id) => pluginSources(id));
}

function lineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
}

/* -------------------------------------------------------------------------- */
/* #1 テストのための口                                                           */
/* -------------------------------------------------------------------------- */

describe('#1 index.ts は引数を与えずに publisher を作る', () => {
  it.each([
    ['sns-x-manual', 'createXManualPublisher'],
    ['sns-x-api', 'createXApiPublisher'],
  ] as const)('#1 %s の index.ts は %s を引数なしで 1 回だけ呼ぶ', (id, factory) => {
    // **本番の経路が既定（globalThis.fetch・実時間・本物の乱数）を通ることを固定する**（設計 §10.1 の 1）。
    const source = readPlugin(id, 'index.ts');
    const calls = [...source.matchAll(new RegExp(`${factory}\\(([^)]*)\\)`, 'g'))];

    expect(calls, `index.ts が ${factory} を呼んでいない`).toHaveLength(1);
    expect(calls[0]?.[1]?.trim()).toBe('');
  });

  it('#1 createXApiPublisher の引数は省略できる（既定値つき、または任意の引数）', () => {
    const source = readPlugin('sns-x-api', 'social.ts');

    expect(source).toMatch(
      /export function createXApiPublisher\(\s*\w+(\?: XApiPublisherOptions|: XApiPublisherOptions = \{\}),?\s*\)/,
    );
  });

  it('#1 XApiPublisherOptions は fetch / now / nonce を持ち、項目はすべて任意', () => {
    const source = readPlugin('sns-x-api', 'social.ts');
    const body = /export interface XApiPublisherOptions \{([\s\S]*?)\n\}/.exec(source)?.[1];

    expect(body, 'XApiPublisherOptions が無い').toBeDefined();
    const members = [...(body ?? '').matchAll(/^\s*(?:readonly\s+)?(\w+)(\??):/gm)].map(
      (match) => ({ name: match[1] ?? '', optional: match[2] === '?' }),
    );
    expect(members.map((member) => member.name).sort()).toEqual(['fetch', 'nonce', 'now']);
    for (const member of members) {
      expect(member.optional, `${member.name} が任意でない`).toBe(true);
    }
  });

  it('#1 createXManualPublisher は引数を取らない', () => {
    // 状態を持たず、外へ出ない（設計 §5.3 / §6）。差し替える口が要らない。
    expect(readPlugin('sns-x-manual', 'social.ts')).toMatch(
      /export function createXManualPublisher\(\s*\)/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #2 外部への HTTP は xapi.ts に閉じる                                           */
/* -------------------------------------------------------------------------- */

/**
 * `globalThis.fetch` と**裸の** `fetch(` の出現位置（`038` の `fetchOccurrences` の写し）。
 *
 * `impl(url, init)` のように変数越しに呼ぶ形は数えない（実装プラン §7 の 1）。
 * `options.fetch` や `fetchImage(` も数えない（`fetch(` の綴りではないため）。
 */
function fetchOccurrences(source: string): readonly number[] {
  const found: number[] = [];
  for (const match of source.matchAll(/globalThis\.fetch|(?<![.\w])fetch\s*\(/g)) {
    found.push(match.index);
  }
  return found;
}

/**
 * `xapi.ts` の中で、既定値の解決（`FetchImpl` の型宣言と `resolveFetch()` の中）の外にある出現の行。
 * `resolveFetch` が無ければ、出現はすべて外にあるとみなす。
 */
function fetchOutsideDefaultResolution(source: string): readonly string[] {
  const start = source.indexOf('export function resolveFetch');
  const end = start === -1 ? -1 : source.indexOf('\n}', start);
  return fetchOccurrences(source)
    .filter((index) => {
      const inResolveFetch = start !== -1 && index > start && index < end;
      const inTypeAlias = /^export type FetchImpl = /.test(lineAt(source, index));
      return !(inResolveFetch || inTypeAlias);
    })
    .map((index) => lineAt(source, index).trim());
}

describe('#2 sns-x-api の外部への HTTP は xapi.ts に閉じている', () => {
  it('#2 xapi.ts 以外のファイルに globalThis.fetch / fetch( が 1 件も無い', () => {
    for (const { path, name, source } of pluginSources('sns-x-api')) {
      if (name === 'xapi.ts') continue;

      expect(fetchOccurrences(source), path).toHaveLength(0);
    }
  });

  it('#2 xapi.ts の出現は既定値の解決（FetchImpl と resolveFetch()）に閉じている', () => {
    const source = readPlugin('sns-x-api', 'xapi.ts');

    expect(source, 'resolveFetch が無い').toContain('export function resolveFetch');
    expect(fetchOccurrences(source).length).toBeGreaterThan(0);
    expect(fetchOutsideDefaultResolution(source)).toEqual([]);
  });

  it('#2 判別力：social.ts の写しに globalThis.fetch を 1 つ足すと出現として数える', () => {
    const original = readPlugin('sns-x-api', 'social.ts');
    const copy = `${original}\nconst leaked = globalThis.fetch;\n`;

    expect(fetchOccurrences(copy)).toHaveLength(fetchOccurrences(original).length + 1);
  });

  it('#2 判別力：xapi.ts の写しの resolveFetch() の外に fetch( を 1 つ足すと見分ける', () => {
    const original = readPlugin('sns-x-api', 'xapi.ts');
    const copy = `${original}\nexport const probe = () => fetch('https://example.test/');\n`;

    expect(fetchOutsideDefaultResolution(copy)).toHaveLength(
      fetchOutsideDefaultResolution(original).length + 1,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #3 x-text.ts と oauth1.ts は純関数だけ                                        */
/* -------------------------------------------------------------------------- */

/** #3 の違反（見つけた綴り）。空なら純関数だけ。 */
function impurities(source: string): readonly string[] {
  const found: string[] = [];
  if (fetchOccurrences(source).length > 0) found.push('fetch');
  if (source.includes('Date.now')) found.push('Date.now');
  if (/new Date\(\s*\)/.test(source)) found.push('new Date()');
  if (source.includes('getRandomValues')) found.push('getRandomValues');
  for (const match of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';$/gm)) {
    const [, clause, specifier] = match;
    if (specifier === '@torifune/plugin-api' && !/^type\s/.test(clause ?? '')) {
      found.push(`value import: ${match[0]}`);
    }
  }
  return found;
}

describe('#3 x-text.ts（2 つ）と oauth1.ts は時計・乱数・fetch・plugin-api の値を持たない', () => {
  const PURE_FILES = [
    ['sns-x-manual', 'x-text.ts'],
    ['sns-x-api', 'x-text.ts'],
    ['sns-x-api', 'oauth1.ts'],
  ] as const;

  it.each(PURE_FILES)(
    '#3 %s/%s に fetch / Date.now / new Date() / getRandomValues / plugin-api の値の import が無い',
    (id, name) => {
      // 時刻と nonce は引数で受ける（設計 §4 / §6.3）。
      expect(impurities(readPlugin(id, name))).toEqual([]);
    },
  );

  it.each([
    ['globalThis.fetch', 'const f = globalThis.fetch;'],
    ['Date.now', 'const t = Date.now();'],
    ['new Date()', 'const d = new Date();'],
    ['getRandomValues', 'const r = crypto.getRandomValues(new Uint8Array(1));'],
    ['plugin-api の値の import', "import { validateManifest } from '@torifune/plugin-api';"],
  ])('#3 判別力：oauth1.ts の写しに %s を足すと違反として見分ける', (_label, line) => {
    const copy = `${line}\n${readPlugin('sns-x-api', 'oauth1.ts')}`;

    expect(impurities(copy).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #4 環境変数を読まない                                                         */
/* -------------------------------------------------------------------------- */

describe('#4 環境変数を読まない', () => {
  it('#4 2 つの Plugin の .ts に process.env が無い', () => {
    // 設定を持たない（設計 §5.3）。環境変数へ口を増やさない。
    for (const { path, source } of allSources()) {
      expect(source, path).not.toContain('process.env');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #5 Manifest                                                                  */
/* -------------------------------------------------------------------------- */

describe.each(PLUGIN_IDS)('#5 %s の Manifest', (id) => {
  it('#5 validateManifest に通る', () => {
    const result = validateManifest(manifest(id), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('#5 id がディレクトリ名と同じで、apiVersion が 1', () => {
    const raw = manifest(id);

    expect(raw['id']).toBe(id);
    expect(raw['apiVersion']).toBe(1);
  });

  it('#5 Permission を 1 つも要求しない', () => {
    // Data API を 1 度も呼ばない（設計 §8）。
    expect(manifest(id)['permissions']).toEqual([]);
  });

  it('#5 拡張点は social ちょうど（ui を含まない）', () => {
    // 使わない拡張点を宣言しない（設計 §8.1）。
    expect(manifest(id)['extensions']).toEqual(['social']);
  });

  it('#5 拡張点は PLUGIN_EXTENSION_KINDS にある値だけ', () => {
    for (const kind of manifest(id)['extensions'] as string[]) {
      expect(PLUGIN_EXTENSION_KINDS as readonly string[], kind).toContain(kind);
    }
  });

  it('#5 dependencies を持たない', () => {
    // 2 つは同時に有効にできないので、依存で結ぶとどちらも有効にできなくなる（設計 §4.1）。
    expect('dependencies' in manifest(id)).toBe(false);
  });

  it('#5 description に「同時には有効にできない」が現れる', () => {
    // 導入前の /plugins で読まれる場所に、入れ替えの前提を置く（設計 §8.1）。
    expect(String(manifest(id)['description'])).toContain('同時には有効にできない');
  });
});

describe('#5 sns-x-manual の Manifest の description', () => {
  it('#5 資格情報を使わない趣旨がある', () => {
    // /plugins の「資格情報を受け取ります」は Core の固定文なので、description で補う（設計 §7 / §11 #9）。
    expect(String(manifest('sns-x-manual')['description'])).toMatch(/資格情報[^。]*使わない/);
  });
});

describe('#87 の前提：Manifest の name', () => {
  it.each([
    ['sns-x-manual', 'X配信（手動投稿）'],
    ['sns-x-api', 'X配信（X API）'],
  ] as const)('%s の name は %s（E2E は name の全体で行を絞る）', (id, name) => {
    // 2 つの name は「X配信」を共有する。E2E は全体（括弧は全角）で絞るので、ここが変わると #87 が当たらない。
    expect(manifest(id)['name']).toBe(name);
  });
});

/* -------------------------------------------------------------------------- */
/* #6 sns-x-manual は外へ要求を出さない                                           */
/* -------------------------------------------------------------------------- */

/** `fetch` という語の出現（コメントや文中の言及も含む。`fetchImage` のような別の識別子は数えない）。 */
function fetchWords(source: string): number {
  return [...source.matchAll(/(?<![\w])fetch(?![\w])/g)].length;
}

describe('#6 sns-x-manual は fetch を持たない', () => {
  it('#6 plugins/sns-x-manual の .ts に fetch / globalThis.fetch が 1 件も無い（コメントを含む）', () => {
    // 外へ 1 本も要求を出さない（設計 §6）。綴りそのものを置かない（実装プラン §7 の 1）。
    const sources = pluginSources('sns-x-manual');

    expect(sources.length).toBeGreaterThan(0);
    for (const { path, source } of sources) {
      expect(fetchWords(source), path).toBe(0);
    }
  });

  it('#6 判別力：social.ts の写しのコメントに fetch を 1 つ足すと見分ける', () => {
    const original = readPlugin('sns-x-manual', 'social.ts');
    const copy = `${original}\n// fetch はしない\n`;

    expect(fetchWords(copy)).toBe(fetchWords(original) + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* #7 本体・DB・react・node:・他の Plugin を import しない                          */
/* -------------------------------------------------------------------------- */

/** `from '…'` / `import '…'` / `import('…')` / `require('…')` の指定子。 */
function importSpecifiers(source: string): readonly string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1] ?? ''));
}

/** 許す指定子は `@torifune/plugin-api` と同じ Plugin のファイル（`./name`）だけ。 */
function isAllowedSpecifier(specifier: string): boolean {
  return specifier === '@torifune/plugin-api' || /^\.\/[\w-]+$/.test(specifier);
}

describe('#7 import するのは @torifune/plugin-api と同じ Plugin のファイルだけ', () => {
  it('#7 2 つの Plugin の import 先は @torifune/plugin-api と ./ だけ', () => {
    for (const { path, source } of allSources()) {
      for (const specifier of importSpecifiers(source)) {
        expect(isAllowedSpecifier(specifier), `${path}: ${specifier}`).toBe(true);
      }
    }
  });

  it.each([
    ['@/', /^@\//],
    ['apps/web', /apps\/web/],
    ['pg', /^pg$/],
    ['kysely', /^kysely$/],
    ['react', /^react$/],
    ['node:', /^node:/],
    ['../（他の Plugin のディレクトリ）', /^\.\.\//],
  ])('#7 2 つの Plugin に %s の import が 0 件', (_label, pattern) => {
    for (const { path, source } of allSources()) {
      const hits = importSpecifiers(source).filter((specifier) => pattern.test(specifier));
      expect(hits, path).toEqual([]);
    }
  });

  it.each([
    ["import { composeXText } from '../sns-x-manual/x-text';"],
    ["import { createServer } from 'node:http';"],
    ["const mod = await import('@/domain/social/social');"],
  ])('#7 判別力：social.ts の写しに「%s」を足すと許されない指定子として見分ける', (line) => {
    const original = readPlugin('sns-x-api', 'social.ts');
    const copy = `${line}\n${original}`;
    const disallowed = (source: string): number =>
      importSpecifiers(source).filter((specifier) => !isAllowedSpecifier(specifier)).length;

    expect(disallowed(copy)).toBe(disallowed(original) + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* #8 console・Key-Value Store・画面・Data API に触れない                           */
/* -------------------------------------------------------------------------- */

describe('#8 console・Key-Value Store・画面・Data API に触れない', () => {
  it.each([
    ['console.', /console\./],
    ['context.store', /context\.store/],
    ['context.ui', /context\.ui/],
    ['context.data', /context\.data/],
    ['store.', /(?<![\w])store\./],
  ])('#8 2 つの Plugin に %s が無い', (_label, pattern) => {
    // 状態を 1 つも持たない（設計 §5.3）。出力は `PublishInput.logger` だけ（設計 §4）。
    for (const { path, source } of allSources()) {
      expect(source, path).not.toMatch(pattern);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #9 2 つの x-text.ts の一致                                                    */
/* -------------------------------------------------------------------------- */

/**
 * #9。**2 つの `x-text.ts` はバイト単位で同じ**（設計 §4.2 の案 D）。
 *
 * 比較は文字列にせず `Buffer` のまま行う（改行コード・BOM・末尾の改行の差も拾う）。
 */
describe('#9 2 つの x-text.ts の一致', () => {
  function xTextBytes(id: PluginId): Buffer {
    return readFileSync(join(PLUGINS_DIR, id, 'x-text.ts'));
  }

  /** #9 の比較関数。判別力の検査にも同じ関数を掛ける。 */
  function sameBytes(left: Buffer, right: Buffer): boolean {
    return left.equals(right);
  }

  it('#9 plugins/sns-x-manual/x-text.ts と plugins/sns-x-api/x-text.ts がバイト単位で一致する', () => {
    const manual = xTextBytes('sns-x-manual');
    const api = xTextBytes('sns-x-api');

    expect(manual.length, '空のファイル同士の一致は検査にならない').toBeGreaterThan(0);
    expect(sameBytes(manual, api)).toBe(true);
  });

  it('#9 比較は 1 文字足した写しを見分ける（判別力）', () => {
    const original = xTextBytes('sns-x-manual');
    const appended = Buffer.concat([original, Buffer.from('a', 'utf8')]);

    expect(sameBytes(original, appended)).toBe(false);
  });

  it('#9 比較は 1 バイトだけ置き換えた写しを見分ける（判別力）', () => {
    const original = xTextBytes('sns-x-manual');
    const replaced = Buffer.from(original);
    const middle = Math.floor(replaced.length / 2);
    replaced[middle] = (replaced[middle] ?? 0) ^ 0x01;

    expect(replaced.length).toBe(original.length);
    expect(sameBytes(original, replaced)).toBe(false);
  });

  it('#9 比較は同じ内容の写しを一致と判定する', () => {
    const original = xTextBytes('sns-x-manual');

    expect(sameBytes(original, Buffer.from(original))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #11 生成された登録簿と README                                                  */
/* -------------------------------------------------------------------------- */

describe('#11 生成された登録簿', () => {
  it.each(PLUGIN_IDS)('#11 generated-registry.ts に %s の行がある', (id) => {
    // `pnpm generate:plugins` の出力。**Git 管理外で、手では書かない。**
    const source = readFileSync(join(import.meta.dirname, 'generated-registry.ts'), 'utf8');

    expect(source).toContain(`plugins/${id}/index`);
    expect(source).toContain(`directory: "${id}"`);
  });
});

describe('#11 README', () => {
  const readme = (id: PluginId): string => readPlugin(id, 'README.md');

  describe.each(PLUGIN_IDS)('#11 %s の README（共通の語）', (id) => {
    it.each(['同時', '入れ替え', '手動投稿', '約24時間'])('#11 「%s」が現れる', (word) => {
      expect(readme(id)).toContain(word);
    });

    // 2026-09-23 に追記（設計 §9.8 / §7 の注。検証の Security 低-1）：画面にアカウントの編集は無く、
    // 既存のアカウントには API で入れる。sns-x-manual の間に出る汎用の欄は空のままにする。
    it.each(['PATCH /api/v1/social/accounts/', '空のまま'])('#11 「%s」が現れる', (word) => {
      expect(readme(id)).toContain(word);
    });

    it('#11 資格情報の入力欄が「無い」「出ない」と書かない（Core の汎用の欄は出る。設計 §7）', () => {
      expect(readme(id)).not.toMatch(/入力欄(は|が)(ありません|無い|ない|出ません|出ない)/);
    });
  });

  it.each(['従量課金', 'Read and write', 'OAuth 2.0', '5MB', 'GIF', 'alt', 'URL', 'Authorization'])(
    '#11 sns-x-api の README に「%s」が現れる',
    (word) => {
      expect(readme('sns-x-api')).toContain(word);
    },
  );

  it('#11 sns-x-manual の README に「manual」が現れる', () => {
    // deliveryMode を省略すると auto になり 422 で断られる。manual を明示させる（設計 §9.8）。
    expect(readme('sns-x-manual')).toContain('manual');
  });

  it.each(PLUGIN_IDS)('#11 %s の README に料金の具体的な数値を書かない', (id) => {
    // **公開されている値は変わる**（設計 §6.1 / §9.8）。X の料金表へ案内するだけにする。
    const text = readme(id);

    expect(text).not.toMatch(/[$＄]\s*\d/);
    expect(text).not.toMatch(/\d[\d,.]*\s*(ドル|円|USD|cents?)/i);
  });
});

/* -------------------------------------------------------------------------- */
/* #12 宛先の定数は 1 か所                                                        */
/* -------------------------------------------------------------------------- */

/** `needle` を含む行を、Plugin のファイルごとに集める（`path: 行`）。 */
function linesContaining(sources: readonly PluginSource[], needle: string): readonly string[] {
  return sources.flatMap(({ path, source }) =>
    source
      .split('\n')
      .filter((line) => line.includes(needle))
      .map((line) => `${path}: ${line.trim()}`),
  );
}

describe('#12 宛先の定数は 1 か所', () => {
  it('#12 api.x.com は sns-x-api/xapi.ts の X_API_BASE_URL の定義 1 行だけに現れる', () => {
    // テストは宛先を書かざるを得ないので、対象は Plugin の .ts（実装プラン §8 の 14）。
    expect(linesContaining(allSources(), 'api.x.com')).toEqual([
      "sns-x-api/xapi.ts: export const X_API_BASE_URL = 'https://api.x.com';",
    ]);
  });

  it('#12 x.com/intent/tweet は 2 つの x-text.ts の X_INTENT_BASE_URL の定義だけに現れる', () => {
    // 2 つの x-text.ts は同一内容（#9）なので 1 か所と数える。
    expect([...linesContaining(allSources(), 'x.com/intent/tweet')].sort()).toEqual([
      "sns-x-api/x-text.ts: export const X_INTENT_BASE_URL = 'https://x.com/intent/tweet';",
      "sns-x-manual/x-text.ts: export const X_INTENT_BASE_URL = 'https://x.com/intent/tweet';",
    ]);
  });

  it('#12 判別力：social.ts の写しに api.x.com を 1 つ足すと、定義の外の出現として見分ける', () => {
    const [social] = pluginSources('sns-x-api').filter(({ name }) => name === 'social.ts');
    if (social === undefined) throw new Error('sns-x-api/social.ts が無い');
    const copy: PluginSource = {
      ...social,
      source: `${social.source}\nconst leaked = 'https://api.x.com/2/tweets';\n`,
    };

    expect(linesContaining([copy], 'api.x.com')).toContain(
      "sns-x-api/social.ts: const leaked = 'https://api.x.com/2/tweets';",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #84 / #88 既存の Plugin の検査を壊さない                                        */
/* -------------------------------------------------------------------------- */

describe('#84 5 つの Plugin が並んでも既存の検査は変わらない', () => {
  it('#84 plugins/ に example-plugin・sns-bluesky・sns-instagram・sns-x-manual・sns-x-api が並ぶ', () => {
    const directories = readdirSync(PLUGINS_DIR).filter((name) =>
      statSync(join(PLUGINS_DIR, name)).isDirectory(),
    );

    for (const name of [
      'example-plugin',
      'sns-bluesky',
      'sns-instagram',
      'sns-x-manual',
      'sns-x-api',
    ]) {
      expect(directories).toContain(name);
    }
  });

  it.each([
    'example-plugin.integration.test.ts',
    'sns-bluesky-static-checks.test.ts',
    'sns-instagram-static-checks.test.ts',
  ])('#84 %s は sns-x を知らない（変更なしで通ることが条件）', (name) => {
    const source = readFileSync(join(import.meta.dirname, name), 'utf8');

    expect(source).not.toContain('sns-x');
  });
});

describe('#88 既存の静的検査は plugins/ を件数でなく名前で見ている', () => {
  it.each(['sns-bluesky-static-checks.test.ts', 'sns-instagram-static-checks.test.ts'])(
    '#88 %s は plugins/ のディレクトリを toContain で見ている',
    (name) => {
      const source = readFileSync(join(import.meta.dirname, name), 'utf8');

      expect(source).toMatch(/expect\(directories\)\.toContain\(/);
    },
  );

  it.each(['sns-bluesky-static-checks.test.ts', 'sns-instagram-static-checks.test.ts'])(
    '#88 %s は plugins/ のディレクトリを件数（toHaveLength / toEqual / toStrictEqual）で見ていない',
    (name) => {
      // 件数で見ていると、4 つ目・5 つ目の Plugin を置いただけで落ちる。
      const source = readFileSync(join(import.meta.dirname, name), 'utf8');

      expect(source).not.toMatch(/expect\(directories\)\.(toHaveLength|toEqual|toStrictEqual)\(/);
    },
  );

  it.each(['sns-bluesky-static-checks.test.ts', 'sns-instagram-static-checks.test.ts'])(
    '#88 %s のテスト本数の検査は自分の Plugin ID で始まるファイルだけを数える',
    (name) => {
      // `sns-x*.test.ts` を足しても、既存の「N 本ちょうど」が落ちない。
      const source = readFileSync(join(import.meta.dirname, name), 'utf8');

      expect(source).toMatch(/name\.startsWith\((PLUGIN_ID|`\$\{PLUGIN_ID\}`)\)/);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #85 E2E は 2 つの Plugin を導入も有効化もしない                                  */
/* -------------------------------------------------------------------------- */

describe('#85 E2E は sns-x-manual / sns-x-api を導入も有効化もしない', () => {
  function specFiles(dir: string = E2E_DIR): readonly string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return specFiles(path);
      return name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('#85 E2E の spec が 1 本以上ある', () => {
    expect(specFiles().length).toBeGreaterThan(0);
  });

  it.each(PLUGIN_IDS)('#85 どの spec にも %s という文字列が現れない', (id) => {
    // 導入・有効化の導線が spec に無い＝**外部への通信が 1 本も出ない**。
    // `/plugins` の表示（#87）は Manifest の `name` で見る。
    for (const path of specFiles()) {
      expect(readFileSync(path, 'utf8'), path).not.toContain(id);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #89（E 側）本物の fetch を外へ出さない仕掛けが、すべてのテストファイルにある           */
/* -------------------------------------------------------------------------- */

/** `beforeEach` で「呼ばれたら投げる」`fetch` を置いているか。 */
function installsThrowingFetch(source: string): boolean {
  return (
    /beforeEach\(\s*(?:async\s*)?\(\)\s*=>\s*\{[\s\S]{0,400}?globalThis\.fetch\s*=\s*throwingFetch\(\)/.test(
      source,
    ) && /function throwingFetch\(\)[\s\S]{0,300}?throw new Error\(/.test(source)
  );
}

/** `afterEach` で元の `fetch` へ戻しているか。 */
function restoresRealFetch(source: string): boolean {
  return /afterEach\(\s*(?:async\s*)?\(\)\s*=>\s*\{[\s\S]{0,400}?globalThis\.fetch\s*=\s*realFetch\b/.test(
    source,
  );
}

/**
 * #89（E 側）。数を固定しておかないと、ファイルが 1 本も無くても下の検査が素通りする（実装プラン §8 の 15）。
 */
describe('#89 テストは本物の fetch を外へ出さない', () => {
  const SELF = basename(import.meta.filename);

  function testFiles(): readonly string[] {
    return readdirSync(import.meta.dirname).filter(
      (name) => name.startsWith('sns-x') && name.endsWith('.test.ts') && name !== SELF,
    );
  }

  function sourceOf(name: string): string {
    return readFileSync(join(import.meta.dirname, name), 'utf8');
  }

  it('#89 対象のテストファイルは単体 6 本と結合 1 本の 7 本ちょうど', () => {
    expect([...testFiles()].sort()).toEqual([
      'sns-x-api-conformance.test.ts',
      'sns-x-api-oauth1.test.ts',
      'sns-x-api-publish.test.ts',
      'sns-x-api.test.ts',
      'sns-x-manual.test.ts',
      'sns-x-text.test.ts',
      'sns-x.integration.test.ts',
    ]);
  });

  it('#89 すべてが beforeEach で globalThis.fetch を「呼ばれたら投げる」に置き換える', () => {
    for (const name of testFiles()) {
      expect(installsThrowingFetch(sourceOf(name)), name).toBe(true);
    }
  });

  it('#89 すべてが afterEach で元の fetch へ戻す', () => {
    // 戻し忘れると、後続のテストファイルが道連れになる。
    for (const name of testFiles()) {
      expect(restoresRealFetch(sourceOf(name)), name).toBe(true);
    }
  });

  it('#89 判別力：投げる fetch を置く行を消した写しは見分ける', () => {
    const copy = sourceOf('sns-x-manual.test.ts').replace(
      /globalThis\.fetch\s*=\s*throwingFetch\(\);/,
      '',
    );

    expect(installsThrowingFetch(copy)).toBe(false);
  });

  it('#89 判別力：元へ戻す行を消した写しは見分ける', () => {
    const copy = sourceOf('sns-x-manual.test.ts').replace(/globalThis\.fetch\s*=\s*realFetch;/, '');

    expect(restoresRealFetch(copy)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #92（E 側）ループバックの検査は本物の fetch をラッパ越しにだけ使う                    */
/* -------------------------------------------------------------------------- */

/**
 * `realFetch` の出現のうち、許されたもの（読み込み時の退避・`afterEach` での戻し・ラッパの中）以外の行。
 * ラッパは `function loopbackFetch(` の本体（次の行頭の `}` まで）。
 */
function realFetchOutsideWrapper(source: string): readonly string[] {
  const start = source.indexOf('function loopbackFetch(');
  const end = start === -1 ? -1 : source.indexOf('\n}', start);
  return [...source.matchAll(/\brealFetch\b/g)]
    .filter((match) => {
      const line = lineAt(source, match.index).trim();
      if (line === 'const realFetch: typeof globalThis.fetch = globalThis.fetch;') return false;
      if (line === 'globalThis.fetch = realFetch;') return false;
      return !(start !== -1 && match.index > start && match.index < end);
    })
    .map((match) => lineAt(source, match.index).trim());
}

describe('#92 本物の fetch はラッパ越しにだけ渡される', () => {
  const conformance = (): string =>
    readFileSync(join(import.meta.dirname, 'sns-x-api-conformance.test.ts'), 'utf8');

  it('#92 本物の fetch をモジュールの読み込み時に退避している', () => {
    expect(conformance()).toMatch(
      /^const realFetch: typeof globalThis\.fetch = globalThis\.fetch;$/m,
    );
  });

  it('#92 本物の fetch を呼ぶのはラッパ（loopbackFetch）の中の 1 か所だけ', () => {
    const source = conformance();
    const start = source.indexOf('function loopbackFetch(');
    const end = source.indexOf('\n}', start);
    const calls = [...source.matchAll(/\brealFetch\(/g)].map((match) => match.index);

    expect(start, 'loopbackFetch が無い').toBeGreaterThan(-1);
    expect(calls).toHaveLength(1);
    expect(calls[0] ?? -1).toBeGreaterThan(start);
    expect(calls[0] ?? -1).toBeLessThan(end);
  });

  it('#92 退避・戻し・ラッパの中のほかに realFetch が現れない（publisher へ直に渡していない）', () => {
    expect(realFetchOutsideWrapper(conformance())).toEqual([]);
  });

  it('#92 判別力：publisher へ本物の fetch を直に渡す行を足した写しは見分ける', () => {
    const copy = `${conformance()}\nconst direct = createXApiPublisher({ fetch: realFetch });\n`;

    expect(realFetchOutsideWrapper(copy)).toHaveLength(1);
  });
});
