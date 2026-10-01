import { describe, expect, it } from 'vitest';
import { compareVersions } from './version-order';

/**
 * CLI と本体の版の比較が一致すること（050-bundled-plugin-sync 設計 §4、受け入れ条件 #20）。
 *
 * CLI は `apps/web` に依存しない（`packages/cli` は本体を import しない）ので、同期が使う版の比較は
 * CLI の中に同じ規則で置く。規則がずれていないことを、本体の側から両方を呼んで確かめる。
 *
 * **CLI の側のモジュールはまだ無い**（実装プラン T1。T3 で `@torifune/cli/plugins/version` を足す）。
 * 型検査を通すため、指定子を変数にした動的 import で読み、実装プラン §2「モジュールの形」の型を当てる。
 */

interface CliVersionModule {
  compareVersions(a: string, b: string): number;
}

const CLI_VERSION_MODULE = '@torifune/cli/plugins/version';
let cliVersionModule: Promise<CliVersionModule> | undefined;

function loadCliVersion(): Promise<CliVersionModule> {
  cliVersionModule ??= import(/* @vite-ignore */ CLI_VERSION_MODULE) as Promise<CliVersionModule>;
  return cliVersionModule;
}

const PAIRS: readonly (readonly [string, string])[] = [
  ['1.0.0', '1.0.0'],
  ['1.2', '1.2.0'],
  ['1.10.0', '1.9.0'],
  ['2.0.0', '1.99.99'],
  ['1.0.0-beta', '1.0.0'],
  ['abc', '0.0.0'],
];

const BOTH_DIRECTIONS = PAIRS.flatMap(([a, b]) => [
  [a, b],
  [b, a],
]) as readonly (readonly [string, string])[];

describe('CLI と本体の版の比較', () => {
  it.each(BOTH_DIRECTIONS)(
    '#20 compareVersions(%s, %s) の符号が CLI と本体で同じ',
    async (a, b) => {
      const cli = await loadCliVersion();

      expect(Math.sign(cli.compareVersions(a, b))).toBe(Math.sign(compareVersions(a, b)));
    },
  );
});
