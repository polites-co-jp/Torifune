import { compareVersions as cliCompareVersions } from '@torifune/cli/plugins/version';
import { describe, expect, it } from 'vitest';
import { compareVersions } from './version-order';

/**
 * CLI と本体の版の比較が一致すること（050-bundled-plugin-sync 設計 §4、受け入れ条件 #20）。
 *
 * CLI は `apps/web` に依存しない（`packages/cli` は本体を import しない）ので、同期が使う版の比較は
 * CLI の中に同じ規則で置く（`packages/cli/src/plugins/version.ts`。`@torifune/cli/plugins/version` として公開）。
 * 規則がずれていないことを、本体の側から両方を呼んで確かめる（`apps/web` のテストは `@torifune/cli` を import してよい）。
 */

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
  it.each(BOTH_DIRECTIONS)('#20 compareVersions(%s, %s) の符号が CLI と本体で同じ', (a, b) => {
    expect(Math.sign(cliCompareVersions(a, b))).toBe(Math.sign(compareVersions(a, b)));
  });
});
