import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 取り出し条件は 1 つの述語（049-publish-claim-conditions 設計 §6.1、受け入れ条件 #24）。
 *
 * `infrastructure/social-repository.ts` の `listDue`・`claimForPublish`・`deferSkipped` が、モジュールの中の
 * 同じ 1 つの述語 `dueForAutoPublish` を参照し、条件（`'delivery_mode'` など）を手で書き直していないことを
 * ソースの形で固定する。手で書き直すと、片方だけ直したときに取り出しと書き込みの条件が黙って食い違う。
 *
 * * 参照は識別子 `dueForAutoPublish` を**語の境界つき**で探す。§6.1 の `.where(dueForAutoPublish)`（括弧なしで渡す）も、
 *   `.where((eb) => dueForAutoPublish(eb))`・`eb.and([dueForAutoPublish(eb), …])`（呼ぶ）も認める（実装プラン §8 の 2）
 * * メソッドの本文は `approval-static-checks.test.ts` の `methodBody` と同じ切り出し（写し。テストファイルから import しない）
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
const REPOSITORY_PATH = join(SRC_DIR, 'infrastructure', 'social-repository.ts');

/** 取り出し条件を共有する 3 つのメソッド（設計 §6.1）。 */
const SHARED_CONDITION_METHODS = ['listDue', 'claimForPublish', 'deferSkipped'] as const;

const PREDICATE_REFERENCE = /\bdueForAutoPublish\b/;

function repositorySource(): string {
  return readFileSync(REPOSITORY_PATH, 'utf8').replaceAll('\r\n', '\n');
}

/**
 * オブジェクトリテラルのメソッド `  async <name>(` から、次のメソッドかオブジェクトの終わりまで。
 *
 * `approval-static-checks.test.ts` の `methodBody` の写し。
 */
function methodBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^  async ${name}\\(`, 'm'));
  expect(start, `${name} の定義が無い`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const end = rest.search(/^ {2}async [A-Za-z]+\(|^\};?$/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** モジュールの関数 `function <name>(` から、最初の行頭の `}` まで（実装プラン §8 の 2）。 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  expect(start, `function ${name} の定義が無い`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.search(/^\}$/m);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('#24 取り出し条件は 1 つの述語', () => {
  it('#24 dueForAutoPublish がモジュールの関数として定義され、delivery_mode の条件を持つ', () => {
    const body = functionBody(repositorySource(), 'dueForAutoPublish');

    expect(body).toContain("'delivery_mode'");
  });

  it.each(SHARED_CONDITION_METHODS)('#24 %s の本文が dueForAutoPublish を参照する', (name) => {
    const body = methodBody(repositorySource(), name);

    expect(body).toMatch(PREDICATE_REFERENCE);
  });

  it.each(SHARED_CONDITION_METHODS)(
    "#24 %s の本文に 'delivery_mode' を直接書いていない",
    (name) => {
      const body = methodBody(repositorySource(), name);

      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain("'delivery_mode'");
    },
  );

  it('#24 判別力：括弧なしで渡す形と、呼ぶ形のどちらも参照として認める', () => {
    const passed = `export const socialRepository = {
  async listDue(connection, limit) {
    return connection.db.selectFrom('social_posts').where(dueForAutoPublish);
  },

  async claimForPublish(connection, id) {
    return connection.db.updateTable('social_posts').where((eb) => eb.and([eb('id', '=', id), dueForAutoPublish(eb)]));
  },
};
`;

    expect(methodBody(passed, 'listDue')).toMatch(PREDICATE_REFERENCE);
    expect(methodBody(passed, 'claimForPublish')).toMatch(PREDICATE_REFERENCE);
  });

  it('#24 判別力：claimForPublish に条件を手で書いた写しを見分ける', () => {
    const tampered = `export const socialRepository = {
  async listDue(connection, limit) {
    return connection.db.selectFrom('social_posts').where(dueForAutoPublish);
  },

  async claimForPublish(connection, id) {
    return connection.db
      .updateTable('social_posts')
      .where('id', '=', id)
      .where((eb) => eb('delivery_mode', '=', 'auto'))
      .where(dueForAutoPublishLegacy);
  },
};
`;
    const body = methodBody(tampered, 'claimForPublish');

    // 似た名前の別の関数は参照に数えない（語の境界）。
    expect(body).not.toMatch(PREDICATE_REFERENCE);
    expect(body).toContain("'delivery_mode'");
    expect(methodBody(tampered, 'listDue')).not.toContain("'delivery_mode'");
  });

  it('#24 判別力：定義の無い写しでは functionBody が落ちる', () => {
    const withoutPredicate = `export const socialRepository = {
  async listDue(connection, limit) {
    return [];
  },
};
`;

    expect(() => functionBody(withoutPredicate, 'dueForAutoPublish')).toThrow();
  });
});
