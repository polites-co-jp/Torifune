import { describe, expect, it } from 'vitest';
import { MAX_RANGE_DAYS } from '../analytics/analytics';
import { analysisRange, countPostsByStatus, summarizeBySite } from './campaign-analysis';

/**
 * キャンペーン分析の組み立て（026-screen-completion 設計 §3.2）。
 *
 * **集計そのものは既存の UseCase が行う。** ここが持つのは
 * 「どの期間を訊くか」と「返ってきた点をどう畳むか」だけ。
 */

describe('analysisRange', () => {
  it('期間はキャンペーンの期間になる', () => {
    // 既定を「直近30日」にすると、終わったキャンペーンを開いて 0 が並ぶ。
    const range = analysisRange('2026-04-01', '2026-04-30', '2026-06-01');

    expect(range.from).toBe('2026-04-01');
    expect(range.to).toBe('2026-04-30');
    expect(range.truncated).toBe(false);
  });

  it('終わりを決めていなければ今日までを見る', () => {
    const range = analysisRange('2026-04-01', null, '2026-04-10');

    expect(range.from).toBe('2026-04-01');
    expect(range.to).toBe('2026-04-10');
  });

  /** 未来の日付を問い合わせても値は無い。 */
  it('終了日が未来でも今日で止める', () => {
    const range = analysisRange('2026-04-01', '2026-12-31', '2026-04-10');

    expect(range.to).toBe('2026-04-10');
  });

  /** まだ始まっていないキャンペーンでも、期間として成立する値を返す。 */
  it('開始日が未来なら開始日だけの期間になる', () => {
    const range = analysisRange('2026-08-01', null, '2026-04-10');

    expect(range.from).toBe('2026-08-01');
    expect(range.to).toBe('2026-08-01');
  });

  /**
   * `listAnalytics` は 400日を超える期間を 422 で拒否する。
   * 画面側で切り上げないと、長く続くキャンペーンの分析が開けない。
   */
  it('長すぎる期間は上限まで切り上げ、切り上げたことを伝える', () => {
    const range = analysisRange('2020-01-01', null, '2026-04-10');

    expect(range.to).toBe('2026-04-10');
    expect(range.truncated).toBe(true);
    expect(range.from > '2020-01-01').toBe(true);

    // 上限ちょうどに収まっていること。
    const from = Date.parse(`${range.from}T00:00:00Z`);
    const to = Date.parse(`${range.to}T00:00:00Z`);
    const days = Math.floor((to - from) / (24 * 60 * 60 * 1000)) + 1;
    expect(days).toBe(MAX_RANGE_DAYS);
  });
});

describe('summarizeBySite', () => {
  const points = [
    { siteId: 'a', metricDate: '2026-04-01', source: 'core', metric: 'pageviews', value: 10 },
    { siteId: 'a', metricDate: '2026-04-02', source: 'core', metric: 'pageviews', value: 5 },
    { siteId: 'a', metricDate: '2026-04-01', source: 'core', metric: 'visitors', value: 3 },
    { siteId: 'b', metricDate: '2026-04-01', source: 'core', metric: 'pageviews', value: 7 },
  ];

  it('サイトごとに指標を畳む', () => {
    const summary = summarizeBySite(points);

    expect(summary.get('a')).toEqual({ pageviews: 15, visitors: 3 });
    expect(summary.get('b')).toEqual({ pageviews: 7, visitors: 0 });
  });

  /** Plugin が入れた指標も混ざる。知らない指標は無視する。 */
  it('知らない指標は数えない', () => {
    const summary = summarizeBySite([
      ...points,
      { siteId: 'a', metricDate: '2026-04-01', source: 'ga', metric: 'bounces', value: 99 },
    ]);

    expect(summary.get('a')).toEqual({ pageviews: 15, visitors: 3 });
  });

  it('点が無ければ空', () => {
    expect(summarizeBySite([]).size).toBe(0);
  });
});

describe('countPostsByStatus', () => {
  it('状態ごとの件数を返す', () => {
    const counts = countPostsByStatus([
      { status: 'draft' },
      { status: 'scheduled' },
      { status: 'published' },
      { status: 'published' },
      { status: 'failed' },
    ]);

    expect(counts).toEqual({ draft: 1, scheduled: 1, published: 2, failed: 1 });
  });

  /** 0件の状態も 0 として出す。欄が消えると「無い」のか「見えない」のか分からない。 */
  it('0件の状態も欄を残す', () => {
    expect(countPostsByStatus([])).toEqual({ draft: 0, scheduled: 0, published: 0, failed: 0 });
  });
});
