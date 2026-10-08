import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type ts from 'typescript';
import {
  PLUGINS_DIR,
  REGISTRY_PATH,
  REPO_ROOT,
  WEB_DIR,
  WEB_SRC_DIR,
  createTypecheckProgram,
  diagnosticFile,
  formatErrors,
  isTestOnlyFile,
  isUnder,
  listBundledPlugins,
  pathKey,
  pluginImportSpecifiers,
  readParsedConfig,
  samePath,
  toPosix,
  typeErrors,
  type TypecheckProgram,
} from '@/test-support/build-typecheck';

/**
 * 本番のビルドの型検査の再現：何も隠さないビルドの設定（052-rebuild-without-tests 設計 §10.2）。
 *
 * `apps/web/tsconfig.build.json` から TypeScript の API でプログラムを組む（ディスクへ書かない）。
 * 「何も隠さない」プログラム P0 は 1 回だけ作り、#7・#8・#9・#15 で共有する。#13 は P0 を `oldProgram` にする。
 *
 * 担当する受け入れ条件：#7・#8・#9・#13・#15。
 * #15 の走査は、合成した文字列でも見分けられることを同じファイルで確かめる（判別力。
 * こちらは `tsconfig.build.json` を要しない）。
 */

const PROGRAM_TIMEOUT = 120_000;

let baselineProgram: TypecheckProgram | undefined;

/** P0（ビルドの設定・何も隠さない）。最初の呼び出しで作り、以後は同じものを返す。 */
function baseline(): TypecheckProgram {
  baselineProgram ??= createTypecheckProgram({ config: 'build' });
  return baselineProgram;
}

/** `node_modules` の下を除いたソースファイル（区切りは `/`）。 */
function ownSourceFiles(built: TypecheckProgram): readonly string[] {
  return built.program
    .getSourceFiles()
    .map((file) => toPosix(file.fileName))
    .filter((fileName) => !fileName.split('/').includes('node_modules'));
}

function hasFile(files: readonly string[], path: string): boolean {
  return files.some((file) => samePath(file, path));
}

describe('#7〜#9 何も隠さないビルドの設定', () => {
  beforeAll(() => {
    baseline();
  }, PROGRAM_TIMEOUT);

  it('#7 プログラムのすべてのソースファイルに、テスト・テスト支援・e2e・playwright.config.ts が無い', () => {
    const files = ownSourceFiles(baseline());
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(isTestOnlyFile)).toEqual([]);
  });

  it('#8 プログラムに同梱 Plugin それぞれのエントリが入っている', () => {
    const files = ownSourceFiles(baseline());
    const plugins = listBundledPlugins();
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins.filter((plugin) => !hasFile(files, plugin.entry)).map((p) => p.id)).toEqual([]);
  });

  it.each([
    'apps/web/src/plugin/generated-registry.ts',
    'apps/web/next.config.ts',
    'apps/web/src/instrumentation.ts',
  ])('#8 プログラムに %s が入っている', (relativePath) => {
    expect(hasFile(ownSourceFiles(baseline()), `${REPO_ROOT}/${relativePath}`)).toBe(true);
  });

  it('#8 ビルドの設定の root files は、検査の設定の root files から #7 の条件のものを除いた集合と等しい', () => {
    const buildRoots = new Set(baseline().rootNames.map(pathKey));
    const checkRoots = readParsedConfig('check').fileNames.map(toPosix);
    const expected = new Set(checkRoots.filter((f) => !isTestOnlyFile(f)).map(pathKey));
    expect([...buildRoots].sort()).toEqual([...expected].sort());
  });

  it('#8 検査の設定との差は 1 件以上ある（テストを外している）', () => {
    const buildRoots = new Set(baseline().rootNames.map(pathKey));
    const checkRoots = readParsedConfig('check').fileNames.map(pathKey);
    expect(checkRoots.filter((f) => !buildRoots.has(f)).length).toBeGreaterThanOrEqual(1);
  });

  it(
    '#9 プログラムの誤りは 0 件',
    () => {
      const errors = typeErrors(baseline().program);
      expect(errors, formatErrors(errors)).toHaveLength(0);
    },
    PROGRAM_TIMEOUT,
  );
});

describe('#13 本体と Plugin の誤りはビルドで止まる', () => {
  const testFile = `${WEB_SRC_DIR}/security-headers.test.ts`;
  const pluginEntry = `${PLUGINS_DIR}/sns-x-manual/index.ts`;
  const productionFile = `${WEB_SRC_DIR}/security-headers.ts`;
  let errors: readonly ts.Diagnostic[] = [];

  beforeAll(() => {
    const p0 = baseline();
    const built = createTypecheckProgram({
      config: 'build',
      injectErrorsInto: [testFile, pluginEntry, productionFile],
      oldProgram: p0.program,
    });
    errors = typeErrors(built.program);
  }, PROGRAM_TIMEOUT);

  it('#13 3 つに誤りを足すと、誤りはちょうど 2 件（同梱 Plugin のエントリと本番のコードの 2322）', () => {
    const summary = errors.map((d) => ({ file: pathKey(diagnosticFile(d)), code: d.code }));
    expect(summary, formatErrors(errors)).toHaveLength(2);
    expect(
      summary.sort((a, b) => a.file.localeCompare(b.file)),
      formatErrors(errors),
    ).toEqual(
      [
        { file: pathKey(productionFile), code: 2322 },
        { file: pathKey(pluginEntry), code: 2322 },
      ].sort((a, b) => a.file.localeCompare(b.file)),
    );
  });

  it('#13 テストファイルの誤りは出ない', () => {
    const fromTests = errors.filter((d) => isTestOnlyFile(diagnosticFile(d)));
    expect(fromTests, formatErrors(fromTests)).toHaveLength(0);
  });
});

describe('#15 同梱 Plugin を直接指すのはレジストリだけ', () => {
  beforeAll(() => {
    baseline();
  }, PROGRAM_TIMEOUT);

  it('#15 root files のうち apps/web の下で、import の解決先が plugins/ の下になるのは generated-registry.ts だけ', () => {
    const pointing = baseline()
      .rootNames.filter((file) => isUnder(file, WEB_DIR))
      .filter((file) => pluginImportSpecifiers(file, readFileSync(file, 'utf8')).length > 0)
      .map(pathKey);
    expect(pointing).toEqual([pathKey(REGISTRY_PATH)]);
  });
});

describe('（判別力）#15 の import 指定子の走査', () => {
  const file = `${WEB_SRC_DIR}/plugin/synthetic.ts`;

  it.each([
    ['複数行の静的 import', "import {\n  a,\n  b,\n} from '../../../../plugins/x/index';\n"],
    ['import type', "import type { P } from '../../../../plugins/x/types';\n"],
    ['export * from', "export * from '../../../../plugins/x/index';\n"],
    ['export { … } from', "export { a } from '../../../../plugins/x/index';\n"],
    ['import()', "const m = await import('../../../../plugins/x/index');\n"],
    ['require()', "const m = require('../../../../plugins/x/index');\n"],
    ['@/ から plugins/ へ出る指定子', "import a from '@/../../../plugins/x/index';\n"],
  ])('%s を「plugins/ を指す」と判定する', (_, text) => {
    expect(pluginImportSpecifiers(file, text)).toHaveLength(1);
  });

  it.each([
    ['パッケージ', "import { definePlugin } from '@torifune/plugin-api';\n"],
    ['同じディレクトリ', "import { a } from './foo';\n"],
    ['@/ の中', "import { a } from '@/plugin/registry';\n"],
    ['plugins という名の別の場所', "import { a } from '../plugins/x';\n"],
  ])('%s は「plugins/ を指さない」と判定する', (_, text) => {
    expect(pluginImportSpecifiers(file, text)).toEqual([]);
  });

  it('実物のレジストリを「plugins/ を指す」と判定する（0 件で素通りしない）', () => {
    const registry = readFileSync(REGISTRY_PATH, 'utf8');
    expect(pluginImportSpecifiers(REGISTRY_PATH, registry).length).toBe(
      listBundledPlugins().length,
    );
  });
});
