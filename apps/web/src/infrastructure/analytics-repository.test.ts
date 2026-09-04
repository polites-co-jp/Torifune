import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 生ログ（`access_logs`）を読む場所の限定（028 設計 §6.3、受け入れ条件 #40。029 設計 §6.4、受け入れ条件 #52 で改訂）。
 *
 * **画面・API から生ログを集計しない**（018 設計 §4.1 の原則を API にも広げる）。
 * `access_logs` に触れてよいのは、記録・日次集計・最終受信の書き戻し（§5.3.4）・
 * 保持期間の削除・公開キーの照合と、**行数を `LIMIT` で固定した診断用の読み取り 2 つ**
 * （生ログの最終受信 `findLatestAccessAt` = 1 行、未集計件数 `countAccessSince` = 最大 1000 行）だけ。
 * 期間で集計するものはロールアップだけ。
 * 上位ページは `analytics.path_pageviews` から引き、生ログを読む `topPaths` / `countTopPaths` は無くす。
 *
 * ソースを静的に検査する。`async 名前(` でメソッドに区切り、本文に `access_logs` を含むものを集める。
 */

const SOURCE_PATH = join(import.meta.dirname, 'analytics-repository.ts');

/** `access_logs` に触れてよいメソッド（受け入れ条件 #52 の 7 つ）。**増やす方向に動かさない。** */
const ALLOWED_ACCESS_LOG_READERS = [
  'aggregateDailyBreakdown',
  'countAccessSince',
  'deleteAccessLogsOlderThan',
  'findLatestAccessAt',
  'findSiteByPublicKey',
  'maxOccurredAtBySite',
  'recordAccess',
];

/** 未集計件数の打ち切り（029 設計 §5.4 / §6.4）。 */
const PENDING_COUNT_LIMIT = 1000;

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

  /** #40 / #52 */
  it('access_logs に触れるメソッドが許可した 7 つ以外に無い', () => {
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

/**
 * 診断用の読み取り（029 設計 §6.4、受け入れ条件 #52）。
 *
 * 足す 2 つは行数を固定した読み取りで、生ログの期間全体を舐めない。
 */
describe('診断用の読み取り', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const methods = methodsOf(source);
  const bodyOf = (name: string): string =>
    methods.find((method) => method.name === name)?.body ?? '';

  /** #52。最終受信は 1 行。 */
  it('findLatestAccessAt があり、access_logs を limit(1) で読む', () => {
    const body = bodyOf('findLatestAccessAt');

    expect(body, 'findLatestAccessAt が無い').not.toBe('');
    expect(body).toContain('access_logs');
    expect(body).toMatch(/limit\(\s*1\s*\)/);
  });

  /** #52。未集計件数は最大 1000 行の副問い合わせ。 */
  it('countAccessSince があり、LIMIT の定数（1000）で打ち切る', () => {
    const body = bodyOf('countAccessSince');

    expect(body, 'countAccessSince が無い').not.toBe('');
    expect(body).toContain('access_logs');
    // 本文に 1000 を直書きするか、定数（1000 で定義）を参照する。
    const usesLiteral = /\b1000\b|1_000\b/.test(body);
    const constant = /\bPENDING_COUNT_LIMIT\s*=\s*(1000|1_000)\b/.test(source);
    expect(usesLiteral || (constant && body.includes('PENDING_COUNT_LIMIT'))).toBe(true);
    expect(PENDING_COUNT_LIMIT).toBe(1000);
  });

  /** #52。`findLastRollupAt` は残す（裁定 #7）。集計値の表だけを読む。 */
  it('findLastRollupAt が残っており、access_logs を読まず analytics を読む', () => {
    const body = bodyOf('findLastRollupAt');

    expect(body, 'findLastRollupAt が無い').not.toBe('');
    expect(body).not.toContain('access_logs');
    expect(body).toContain('analytics');
  });
});
