import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 生ログ（`access_logs`）を読む場所の限定（028 設計 §6.3、受け入れ条件 #40）。
 *
 * **画面・API から生ログを集計しない**（018 設計 §4.1 の原則を API にも広げる）。
 * `access_logs` に触れてよいのは、記録・日次集計・最終受信の書き戻し（§5.3.4）・
 * 保持期間の削除・公開キーの照合だけ。いずれもロールアップ・受け口・保持期間の処理で、
 * 画面・API からは呼ばれない。
 * 上位ページは `analytics.path_pageviews` から引き、生ログを読む `topPaths` / `countTopPaths` は無くす。
 *
 * ソースを静的に検査する。`async 名前(` でメソッドに区切り、本文に `access_logs` を含むものを集める。
 */

const SOURCE_PATH = join(import.meta.dirname, 'analytics-repository.ts');

/** `access_logs` に触れてよいメソッド（受け入れ条件 #40 の 5 つ）。**増やす方向に動かさない。** */
const ALLOWED_ACCESS_LOG_READERS = [
  'aggregateDailyBreakdown',
  'deleteAccessLogsOlderThan',
  'findSiteByPublicKey',
  'maxOccurredAtBySite',
  'recordAccess',
];

interface MethodSource {
  readonly name: string;
  readonly body: string;
}

/** コメントを落としたソースを `async 名前(` で区切る。 */
function methodsOf(source: string): MethodSource[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const heads = [...withoutComments.matchAll(/^\s*async (\w+)\(/gm)];

  return heads.map((head, index) => {
    const start = head.index ?? 0;
    const end = heads[index + 1]?.index ?? withoutComments.length;
    return { name: head[1] ?? '', body: withoutComments.slice(start, end) };
  });
}

describe('生ログを読む関数の限定', () => {
  const methods = methodsOf(readFileSync(SOURCE_PATH, 'utf8'));

  /** #40 */
  it('access_logs に触れるメソッドが許可した 5 つ以外に無い', () => {
    const offending = methods
      .filter((method) => method.body.includes('access_logs'))
      .map((method) => method.name)
      .filter((name) => !ALLOWED_ACCESS_LOG_READERS.includes(name))
      .sort();

    expect(offending, `access_logs に触れている: ${offending.join(', ')}`).toEqual([]);
  });

  /** #40。区切りが効いていること（検査が空振りしていない）。 */
  it('記録と日次集計は access_logs に触れている', () => {
    const readers = new Set(
      methods.filter((method) => method.body.includes('access_logs')).map((method) => method.name),
    );

    expect(readers).toContain('recordAccess');
    expect(readers).toContain('aggregateDailyBreakdown');
    expect(readers).toContain('deleteAccessLogsOlderThan');
  });

  /** #40 / §6.3。生ログから上位ページを引く関数は無い。 */
  it('topPaths / countTopPaths が無い', () => {
    const names = methods.map((method) => method.name);

    expect(names).not.toContain('topPaths');
    expect(names).not.toContain('countTopPaths');
  });
});
