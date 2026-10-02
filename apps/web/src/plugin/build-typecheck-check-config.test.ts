import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLUGINS_DIR,
  REGISTRY_PATH,
  WEB_SRC_DIR,
  createTypecheckProgram,
  diagnosticFile,
  diagnosticMessage,
  formatErrors,
  isUnder,
  listBundledPlugins,
  samePath,
  typeErrors,
} from '@/test-support/build-typecheck';

/**
 * 検査の設定（`apps/web/tsconfig.json`。`pnpm typecheck` が使う）の振る舞いを固定する
 * （052-rebuild-without-tests 設計 §10.2）。
 *
 * ビルドの設定だけが変わり、検査の設定はテストファイルまで今までどおり見ることを確かめる。
 * #12 は不具合（設計 §1.2 の 7）をこの設定で再現し、ビルドの設定のテスト（#10・#11）が
 * 「同梱 Plugin のフォルダが無い」状態を本当に作れていることの判別力を持つ。
 *
 * 担当する受け入れ条件：#12・#14。
 */

const PROGRAM_TIMEOUT = 120_000;

function readRepositoryRegistry(): string | null {
  return existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, 'utf8') : null;
}

let registryBefore: string | null = null;

beforeAll(() => {
  registryBefore = readRepositoryRegistry();
});

afterAll(() => {
  // 生成を写しの中で走らせたことの確かめ（リポジトリを書き換えない）。
  expect(readRepositoryRegistry()).toBe(registryBefore);
});

describe('#12 検査の設定は同梱 Plugin が無いと落ちる（判別力）', () => {
  const hiddenId = 'sns-threads';

  it(
    '#12 sns-threads を隠すと、検査の設定では apps/web/src/plugin/ のテストファイルに code 2307 の誤りが出る',
    () => {
      // 前提：sns-threads が同梱 Plugin として在る。無ければ飛ばさずに落とす。
      expect(
        listBundledPlugins().map((plugin) => plugin.id),
        `${PLUGINS_DIR}/${hiddenId} が同梱 Plugin として無い（#12 の前提が崩れた）`,
      ).toContain(hiddenId);

      const { program } = createTypecheckProgram({ config: 'check', hidden: [hiddenId] });
      const errors = typeErrors(program);
      expect(errors.length, formatErrors(errors)).toBeGreaterThan(0);

      const unresolved = errors.filter(
        (d) =>
          d.code === 2307 &&
          isUnder(diagnosticFile(d), `${WEB_SRC_DIR}/plugin`) &&
          /\.test\.ts$/.test(diagnosticFile(d)) &&
          diagnosticMessage(d).includes(`plugins/${hiddenId}/`),
      );
      expect(unresolved.length, formatErrors(errors)).toBeGreaterThan(0);
    },
    PROGRAM_TIMEOUT,
  );
});

describe('#14 検査の設定はテストの誤りで落ちる', () => {
  it(
    '#14 security-headers.test.ts に型の誤りを足すと、検査の設定ではそのファイルの code 2322 が出る',
    () => {
      const testFile = `${WEB_SRC_DIR}/security-headers.test.ts`;
      const { program } = createTypecheckProgram({ config: 'check', injectErrorsInto: [testFile] });
      const errors = typeErrors(program);
      const inTestFile = errors.filter(
        (d) => d.code === 2322 && samePath(diagnosticFile(d), testFile),
      );
      expect(inTestFile.length, formatErrors(errors)).toBeGreaterThan(0);
    },
    PROGRAM_TIMEOUT,
  );
});
