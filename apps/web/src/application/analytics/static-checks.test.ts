import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 当日まわりの静的検査（030-analytics-today 設計 §5.2 / §5.3 / §7.4.3 / §7.5.1 / §11.2、
 * 受け入れ条件 #28、#70、#71、#72、#73、#77、#85、#86）。
 *
 * `application/jobs/static-checks.test.ts` と同じく、ソース・ファイルを読んで形を固定する。
 *
 * ここへ寄せるのは、**実行時には数えられない／再現できない**性質だけ。
 *
 * - `statement_timeout` を「渡さなければ設定しない」（渡さない経路を実行して差が出ない）
 * - 「表示が DB 書き込みを起こさない」の構造側（呼んでいない関数を実行時には示せない）
 * - 「問い合わせが 1 つも増えない」（クエリカウンタが本体にもテスト支援にも無い。
 *   入れれば `Connection` の抽象へ計測用の口を足すことになる）
 * - `Alert` の `tone`（`danger` 以外はすべて `role="status"` なので、
 *   `info` / `success` / `warning` を描画からは見分けられない）
 */

/** apps/web/src/application/analytics → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');

function read(...segments: string[]): string {
  return readFileSync(join(SRC_DIR, ...segments), 'utf8');
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/**
 * 切り出しは**空文字で返す**（`expect` を投げない）。
 *
 * `describe` の本体で投げるとファイルごと収集に失敗し、他の検査が 1 つも評価されない。
 * 「見つからない」も `it` の中で 1 件ずつ落とす。
 */

/** `async 名前(` で区切って、そのメソッドの本文だけを取り出す。無ければ空文字。 */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start < 0) {
    return '';
  }
  const rest = source.slice(start + `async ${name}(`.length);
  const next = rest.search(/^ {2}async \w+\(/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** `export const 名前 = ...` から次の `export ` までを取り出す。無ければ空文字。 */
function exportedBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^export const ${name}\\b`, 'm'));
  if (start < 0) {
    return '';
  }
  const rest = source.slice(start + 1);
  const next = rest.search(/^export /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * #28 / #72。ロールアップは引数を渡さない。**既存の呼び出しは 1 文字も変わらない。**
 *
 * 渡してしまうと、定期実行が 5 秒で打ち切られ、サイトを 1 つに絞って集計するようになる。
 * どちらも現行の挙動を静かに壊す。
 */
describe('ロールアップの経路が変わらない（#28 / #72）', () => {
  const rollup = withoutComments(read('application', 'analytics', 'rollup.ts'));

  it('rollup.ts が aggregateDailyBreakdown を呼んでいる（検査が空振りしていない）', () => {
    expect(rollup).toContain('aggregateDailyBreakdown');
  });

  /**
   * 渡す引数を組み立てている行（`window`）。
   *
   * **ファイル全体で `siteId` を探さない。** `replaceCorePoints(tx, group.siteId, …)` のように
   * 書き込み側では正しく使っており、それまで禁じてしまうと検査が嘘になる。
   */
  const windowLine = /const window\s*=\s*(\{[^}]*\})/.exec(rollup)?.[1] ?? '';

  it('rollup.ts が aggregateDailyBreakdown へ渡す引数を組み立てている（検査が空振りしていない）', () => {
    expect(windowLine, 'const window = { … } が見つからない').not.toBe('');
    expect(rollup).toMatch(/aggregateDailyBreakdown\(\s*connection\s*,\s*window\s*\)/);
  });

  it('渡す引数に siteId が入っていない（全サイトを対象にしたまま）', () => {
    expect(windowLine).not.toContain('siteId');
  });

  it('渡す引数に statementTimeoutMs が入っていない（定期実行に上限を掛けない）', () => {
    expect(windowLine).not.toContain('statementTimeoutMs');
  });

  /** 全サイトを対象にしたままであること（範囲とタイムゾーンだけを渡す）。 */
  it('渡すのは範囲とタイムゾーンだけ', () => {
    expect(windowLine).toMatch(/\{\s*\.\.\.range,\s*timeZone:/);
  });
});

/**
 * #28。`SET LOCAL statement_timeout` は `statementTimeoutMs` の分岐の中にしかない。
 *
 * 分岐の外にあると、ロールアップにも上限が掛かる。
 * 「渡さなければ設定しない」は、渡さない経路を実行しても差が出ないので実行時には見られない。
 */
describe('statement_timeout の掛け方（#28）', () => {
  const repository = read('infrastructure', 'analytics-repository.ts');
  const body = methodBody(repository, 'aggregateDailyBreakdown');

  it('TODAY_AGGREGATION_TIMEOUT_MS を export している', () => {
    expect(repository).toMatch(/export const TODAY_AGGREGATION_TIMEOUT_MS\s*=\s*5000/);
  });

  it('aggregateDailyBreakdown が statementTimeoutMs を受け取る', () => {
    expect(body).toContain('statementTimeoutMs');
  });

  it('SET LOCAL statement_timeout が statementTimeoutMs の分岐より後にしか無い', () => {
    const setLocal = body.indexOf('SET LOCAL statement_timeout');
    expect(setLocal, 'SET LOCAL statement_timeout が無い').toBeGreaterThanOrEqual(0);

    // 分岐（`statementTimeoutMs` の参照）が先に立っていること。
    const guard = body.indexOf('statementTimeoutMs');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(setLocal);
  });

  it('SET LOCAL statement_timeout は 1 箇所だけ', () => {
    expect((body.match(/SET LOCAL statement_timeout/g) ?? []).length).toBe(1);
  });

  /** `SET LOCAL` はトランザクション終了で戻る。`SET`（セッション）にすると接続へ残る。 */
  it('SET SESSION / 素の SET statement_timeout を使っていない', () => {
    expect(body).not.toMatch(/SET SESSION statement_timeout/);
    expect(body).not.toMatch(/SET\s+statement_timeout/);
  });

  /** 同じセッションで設定するために、トランザクションの中で流す。 */
  it('statementTimeoutMs のときは connection.transaction の中で流す', () => {
    expect(body).toContain('transaction');
  });
});

/**
 * #70 / #71。**画面の表示が DB 書き込みを起こす作りにしない**（裁定 3.1）。
 *
 * 結合テスト（呼び出しの前後で行が変わらない）と両輪。
 * 構造側でも「書き込む関数を呼んでいない」ことを固定しておく。
 */
describe('当日は書き込まない（#70 / #71）', () => {
  const useCases = withoutComments(read('application', 'analytics', 'analytics-use-cases.ts'));
  const body = exportedBody(useCases, 'getTodayAnalytics');

  it('analytics-use-cases.ts に getTodayAnalytics がある', () => {
    expect(body, 'getTodayAnalytics が見つからない').not.toBe('');
  });

  it('getTodayAnalytics が aggregateDailyBreakdown を呼んでいる（検査が空振りしていない）', () => {
    expect(body).toContain('aggregateDailyBreakdown');
  });

  it.each(['replaceCorePoints', 'putPoint', 'touchLastSeen'])(
    'getTodayAnalytics の本文に %s が現れない',
    (forbidden) => {
      expect(body).not.toContain(forbidden);
    },
  );

  /** 保存しないので `analytics.rolledUp` も発火しない（「集計が済んだ単位」に当たらない）。 */
  it('getTodayAnalytics がイベントを発火しない', () => {
    expect(body).not.toContain('emit(');
  });

  /** 参照系なので監査ログも残さない。 */
  it('getTodayAnalytics に audit が無い', () => {
    expect(body).not.toContain('audit:');
  });

  /** §13-3。当日は `analytics` を読まない。生ログだけを見る。 */
  it.each(['listPoints', 'sumByKey'])('getTodayAnalytics が %s を呼ばない', (forbidden) => {
    expect(body).not.toContain(forbidden);
  });
});

/**
 * #73。ダッシュボードの期間と数値が変わらない（要件 §7-2）。
 *
 * ダッシュボードは「直近 7 日（今日を含む）」を自前で組んでおり `presetRange` を使っていない。
 * 使い始めた瞬間に「今日を含む」が壊れるので、import しないことを固定する。
 */
describe('ダッシュボードは変えない（#73）', () => {
  const dashboard = withoutComments(read('app', 'dashboard', 'page.tsx'));

  it('app/dashboard/page.tsx が presetRange を import していない', () => {
    expect(dashboard).not.toContain('presetRange');
  });

  it('app/dashboard/page.tsx が getTodayAnalytics を呼んでいない', () => {
    expect(dashboard).not.toContain('getTodayAnalytics');
  });

  /** 自前で範囲を組んでいること（検査が空振りしていない）。 */
  it('app/dashboard/page.tsx が shiftDays と todayInTimeZone で範囲を組んでいる', () => {
    expect(dashboard).toContain('shiftDays');
    expect(dashboard).toContain('todayInTimeZone');
  });
});

/**
 * #85。§7.5.1 の判定のために、DB への問い合わせが 1 つも増えない。
 *
 * 問い合わせの回数を実行時に数える仕組みは本体にもテスト支援にも無い。
 * 入れれば `Connection` の抽象へ計測用の口を足すことになるので、**構造で保証する**。
 *
 * 1. 述語の置き場（`ui/analytics/analytics-query.ts`）が Application を import しない同期関数
 * 2. `app/analytics/page.tsx` が呼ぶ UseCase が 5 つのまま
 */
describe('案内の判定で問い合わせが増えない（#85）', () => {
  const query = withoutComments(read('ui', 'analytics', 'analytics-query.ts'));
  const page = read('app', 'analytics', 'page.tsx');

  it('analytics-query.ts が @/application を import しない（I/O を持てない）', () => {
    expect(query).not.toMatch(/from ['"]@\/application/);
  });

  it('analytics-query.ts が @/infrastructure を import しない', () => {
    expect(query).not.toMatch(/from ['"]@\/infrastructure/);
  });

  it('shouldShowStaleRangeNotice が同期関数として宣言されている', () => {
    expect(query).toMatch(/export function shouldShowStaleRangeNotice\s*\(/);
    expect(query).not.toMatch(/export async function shouldShowStaleRangeNotice\s*\(/);
  });

  /** `resolvePeriod` もここへ移す（設計 §14 が単体テストの対象として挙げている）。 */
  it('resolvePeriod が analytics-query.ts から export されている', () => {
    expect(query).toMatch(/export function resolvePeriod\s*\(/);
  });

  /**
   * `page.tsx` が `@/application/analytics/analytics-use-cases` から取る**値**は 5 つだけ。
   *
   * 6 つ目が増えたら、それは問い合わせが 1 つ増えたということ。
   */
  it('page.tsx が呼ぶ UseCase は 5 つ（型の import は数えない）', () => {
    const block =
      /import\s*\{([\s\S]*?)\}\s*from\s*['"]@\/application\/analytics\/analytics-use-cases['"]/.exec(
        page,
      );
    expect(block, 'analytics-use-cases の import が見つからない').not.toBeNull();

    const names = (block?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('type '));

    expect(names.sort()).toEqual([
      'getAnalyticsStatus',
      'getTodayAnalytics',
      'listAnalytics',
      'listAnalyticsBreakdown',
      'listTrackedSites',
    ]);
  });

  /** 最終受信は `getAnalyticsStatus` が既に返している。追加で引かない。 */
  it('page.tsx が受信状況を引き直さない（findLatestAccessAt を直接呼ばない）', () => {
    expect(withoutComments(page)).not.toContain('findLatestAccessAt');
  });

  /** 画面から Repository を直接呼ばない（UI → Infrastructure の直行を禁じる）。 */
  it('page.tsx が analyticsRepository を import しない', () => {
    expect(page).not.toContain('analyticsRepository');
  });
});

/**
 * #77 / #86。案内と注記の `tone` は `info`。
 *
 * `Alert` は `danger` だけ `role="alert"`、他はすべて `role="status"` なので、
 * `role` からは `info` / `success` / `warning` を見分けられない。
 * ユニット（`role="status"`）と、ここ（`tone="info"` の宣言）の 2 段で見る。
 *
 * `AlertTone` は `'info' | 'success' | 'warning' | 'danger'` の 4 つ。**`neutral` は無い。**
 */
describe('案内と注記の tone（#77 / #86）', () => {
  const view = read('ui', 'analytics', 'analytics-view.tsx');
  const primitives = read('ui', 'components', 'primitives.tsx');

  /** 前提。`AlertTone` に `neutral` が無いこと。 */
  it('AlertTone は info / success / warning / danger の 4 つ', () => {
    expect(primitives).toMatch(
      /export type AlertTone\s*=\s*'info'\s*\|\s*'success'\s*\|\s*'warning'\s*\|\s*'danger'/,
    );
  });

  /** #77 / #86 */
  it('analytics-view.tsx に tone="neutral" が無い', () => {
    expect(view).not.toContain('tone="neutral"');
    expect(view).not.toContain("tone='neutral'");
  });

  /** #77 / #86。§7.5.1 の案内と §7.4.3 の注記の 2 つ。 */
  it('analytics-view.tsx に tone="info" の Alert が 2 つ以上ある', () => {
    expect((view.match(/tone="info"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  /** #77。案内を単体テストできるように named export する（実装プラン §8 #17）。 */
  it('StaleRangeNotice が analytics-view.tsx から export されている', () => {
    expect(view).toMatch(/export function StaleRangeNotice\s*\(/);
  });

  /** §7.5.1。案内は `AnalyticsView` に 1 つだけ描く（タブごとに書かない）。 */
  it('StaleRangeNotice を描く箇所が 1 つだけ', () => {
    expect((view.match(/<StaleRangeNotice/g) ?? []).length).toBe(1);
  });
});

/**
 * §7.1.3 / 実装プラン §9。共通部品を変えずに「当日」を出す。
 *
 * `SegmentedControl` を変えると他の画面の見え方・読み上げ方まで変わる。
 * 当日は「項目 1 つの `SegmentedControl` をもう 1 つ置く」で足りる。
 */
describe('共通部品を変えない（§7.1.3）', () => {
  const view = read('ui', 'analytics', 'analytics-view.tsx');
  const control = read('ui', 'components', 'segmented-control.tsx');

  it('SegmentedControl の選択判定は current との一致のまま', () => {
    expect(control).toMatch(/item\.key === current/);
  });

  /** `period === 'today'` のとき 6 項目のどれも選択状態にならない（部品側の変更は要らない）。 */
  it('segmented-control.tsx に today の分岐が無い', () => {
    expect(control).not.toContain('today');
  });

  /** 期間セグメントと「当日」で 2 つ置く。 */
  it('analytics-view.tsx が SegmentedControl を 2 つ描く', () => {
    expect((view.match(/<SegmentedControl/g) ?? []).length).toBe(2);
  });
});

/**
 * ページ送りと案内の判定を `page.tsx` に直書きしない（設計 §12.3、受け入れ条件 #58 / #84）。
 *
 * 検証レポート §3.1 の指摘そのもの。**算術と条件が画面の中にあると、
 * 取り違えても画面全体を組み上げるテストでしか気づけない。**
 * 純粋モジュールへ寄せておけば、境界を単体で決定的に固定できる。
 */
describe('ページ送りと案内の判定の置き場（#58 / #84）', () => {
  const query = withoutComments(read('ui', 'analytics', 'analytics-query.ts'));
  const page = withoutComments(read('app', 'analytics', 'page.tsx'));

  /** #58。切り出しは純関数として export する。 */
  it('analytics-query.ts が pageSlice を export している', () => {
    expect(query).toContain('export function pageSlice');
  });

  /** #58。`page.tsx` はそれを呼ぶだけにする。 */
  it('page.tsx が pageSlice を使う', () => {
    expect(page).toContain('pageSlice');
  });

  /**
   * #58。**オフセットの算術が画面に残っていない。**
   *
   * `(page - 1) * perPage` の形が `page.tsx` にあるなら、それは切り出しを
   * 純関数へ寄せ切れていないということ。
   */
  it('page.tsx にページ送りのオフセット算術が残っていない', () => {
    // 空白を落として素の部分文字列で見る（正規表現のエスケープに依存させない）。
    const packed = page.replace(/\s+/g, '');

    for (const arithmetic of ['-1)*options.perPage', '-1)*perPage', '-1)*TABLE_PER_PAGE']) {
      expect(packed, arithmetic).not.toContain(arithmetic);
    }
  });

  /** #84。6 条件は述語が持つ。画面の分岐に散らさない。 */
  it('page.tsx が hasConfirmedRange を述語へ渡している', () => {
    expect(page).toContain('hasConfirmedRange');
  });

  /** #84。述語が 6 条件すべてを受け取る形になっている。 */
  it('shouldShowStaleRangeNotice が hasConfirmedRange を受け取る', () => {
    const predicate = query.slice(query.indexOf('export function shouldShowStaleRangeNotice'));

    expect(predicate).toContain('hasConfirmedRange');
  });
});

/**
 * 空状態を部品として描く（設計 §7.2、受け入れ条件 #61）。
 *
 * 空状態が出るのは月の 1 日だけなので、画面全体を組み上げるテストでは
 * 実行日が 1 日のときしか通らない（検証レポート §3.1 #61）。
 * 単独で描画できる形にして、実行日に依らず確かめられるようにする。
 */
describe('月の 1 日の空状態（#61）', () => {
  const view = read('ui', 'analytics', 'analytics-view.tsx');

  it('EmptyPeriodNotice が analytics-view.tsx から export されている', () => {
    expect(view).toContain('export function EmptyPeriodNotice');
  });

  /** §7.2。`AnalyticsView` は `empty-period` のときにこれを 1 つ置くだけにする。 */
  it('EmptyPeriodNotice を描く箇所が 1 つだけ', () => {
    expect((view.match(/<EmptyPeriodNotice/g) ?? []).length).toBe(1);
  });
});

/**
 * 034-analytics-period-scope の静的検査（実装プラン §2「テストの方法」の (a)〜(e)）。
 *
 * ここへ寄せるのは、**描画からは見分けられない構造**だけ。
 *
 * - (a) `PeriodBar` を描く箇所が 1 つだけ（#39。タブごとに書いていないこと）
 * - (b) 出し分けが `shouldShowPeriodBar` に閉じている（#40〜#42。条件が画面に散っていない）
 * - (c) 1 日の出し分けの根拠が `days` である（#33 / #35。当日という値ではない）
 * - (d) `overview-tab.tsx` が `rangeText` を import しなくなっている（#52）
 * - (e) `settings-tab.tsx` に `caption=` が無い（#53）
 * - #22。`analyticsHeaderText` が `rangeText` を使い続けている
 *
 * **値や文言の検査をここへ逃がさない**（実装プラン §7 #11）。
 */
describe('034: 適用中の期間の表示（#39〜#42 / #52 / #53）', () => {
  const view = read('ui', 'analytics', 'analytics-view.tsx');
  const overview = withoutComments(read('ui', 'analytics', 'overview-tab.tsx'));
  const settings = withoutComments(read('ui', 'analytics', 'settings-tab.tsx'));
  const labels = withoutComments(read('ui', 'analytics', 'labels.ts'));

  /** (a) #39。単体で描けるように named export する（`StaleRangeNotice` と同じ理由）。 */
  it('(a) PeriodBar が analytics-view.tsx から export されている', () => {
    expect(view).toMatch(/export function PeriodBar\s*\(/);
  });

  /**
   * (a) #39。**`AnalyticsView` に 1 つだけ置く。** タブごとに書かない。
   *
   * タブごとに書くと、タブによって出たり出なかったりする状態を実行時にしか見つけられない。
   */
  it('(a) PeriodBar を描く箇所が 1 つだけ', () => {
    expect((view.match(/<PeriodBar/g) ?? []).length).toBe(1);
  });

  /** (b) #40〜#42。出し分けの述語を named export する（実装プラン §8 #2）。 */
  it('(b) shouldShowPeriodBar が analytics-view.tsx から export されている', () => {
    expect(view).toMatch(/export function shouldShowPeriodBar\s*\(/);
  });

  /**
   * (b) #40〜#42。`AnalyticsView` はその述語で分岐する。
   *
   * 条件を画面に直書きすると、`empty-period`（実行日が月の 1 日でないと E2E で作れない）を
   * 決定的に確かめられなくなる。
   */
  it('(b) AnalyticsView が shouldShowPeriodBar で分岐している', () => {
    expect(withoutComments(view)).toContain('shouldShowPeriodBar(');
  });

  /** §7.3.4。期間の文字列は `AnalyticsView` が **1 回だけ**組み立てる。 */
  it('analytics-view.tsx が appliedPeriodText を 1 回だけ呼ぶ', () => {
    expect((withoutComments(view).match(/appliedPeriodText\(/g) ?? []).length).toBe(1);
  });

  /** §7.3.4。**タブは文字列を組み立てない**（渡された文字列を並べるだけ）。 */
  it.each(['overview-tab.tsx', 'pages-tab.tsx', 'referrers-tab.tsx', 'visitors-tab.tsx'])(
    '%s が appliedPeriodText を呼ばない',
    (file) => {
      expect(withoutComments(read('ui', 'analytics', file))).not.toContain('appliedPeriodText');
    },
  );

  /** (d) #52。「日次の推移」の `aside` から期間を外したので、import ごと消える。 */
  it('(d) overview-tab.tsx が rangeText を import しない', () => {
    expect(overview).not.toContain('rangeText');
  });

  /** (d) #52。代わりに `caption` へ渡している（検査が空振りしていない）。 */
  it('(d) overview-tab.tsx が caption を渡している', () => {
    expect(overview).toContain('caption=');
  });

  /** (e) #53。設定タブは期間に依存しない。 */
  it('(e) settings-tab.tsx に caption= が無い', () => {
    expect(settings).not.toContain('caption=');
  });

  /** (e) #53。`periodCaption` も受け取らない。 */
  it('(e) settings-tab.tsx が periodCaption を受け取らない', () => {
    expect(settings).not.toContain('periodCaption');
  });

  /**
   * #22。**`rangeText` は変えない。** ヘッダ行の「前期間（… 〜 …）」は 030 §7.4.1 の契約で、
   * E2E が文言を固定している。当期の表示のために既存の契約を動かさない。
   */
  it('#22 analyticsHeaderText が rangeText を使い続けている', () => {
    const header = labels.slice(labels.indexOf('export function analyticsHeaderText'));

    expect(header).toContain('rangeText(');
  });

  /** #23。案内の「この期間（…）」は `dateRangeText` を使う。 */
  it('#23 staleRangeNoticeText が dateRangeText を使う', () => {
    const notice = labels.slice(labels.indexOf('export function staleRangeNoticeText'));
    const body = notice.slice(0, notice.indexOf('export ', 1));

    expect(body).toContain('dateRangeText(');
    expect(body).not.toContain('rangeText(');
  });

  /** 実装プラン §8 #4。日数は `rangeDays`（両端を含む）を使う。独自に数えない。 */
  it('labels.ts が rangeDays を Domain から取る', () => {
    expect(labels).toMatch(/import\s*\{[^}]*rangeDays[^}]*\}\s*from\s*['"]@\/domain\/analytics/);
  });
});

/**
 * 034: 期間が 1 日のときの出し分け（設計 §7.2、受け入れ条件 #33 / #35 の静的側）。
 *
 * 「当日だから出さない」を**「期間が 1 日だから出さない」**へ一般化する。
 * 根拠が期間の長さなのだから、条件も期間の長さで書く。
 *
 * **直帰率・平均滞在の注記は `isToday` のまま**（確定値に当日の注記を出さない）。
 */
describe('034: 1 日の期間の出し分け（#33 / #35）', () => {
  const page = withoutComments(read('app', 'analytics', 'page.tsx'));

  /** `key:` から次の `key2:` までを取り出す。無ければ空文字。 */
  function fieldBody(source: string, key: string, until: string): string {
    const start = source.indexOf(`${key}:`);
    if (start < 0) {
      return '';
    }
    const rest = source.slice(start);
    const end = rest.indexOf(`${until}:`);
    return end === -1 ? rest : rest.slice(0, end);
  }

  const dailyBranch = fieldBody(page, 'daily', 'topPages');
  const perDayBranch = fieldBody(page, 'perDay', 'hours');

  it('page.tsx に daily の分岐がある（検査が空振りしていない）', () => {
    expect(dailyBranch, 'daily: の分岐が見つからない').not.toBe('');
  });

  it('page.tsx に perDay の分岐がある（検査が空振りしていない）', () => {
    expect(perDayBranch, 'perDay: の分岐が見つからない').not.toBe('');
  });

  /** (c) #33。`daily` の分岐の根拠は期間の長さ。 */
  it('(c) daily の分岐が days === 1 を根拠にしている', () => {
    expect(dailyBranch.replace(/\s+/g, '')).toContain('days===1');
  });

  /** (c) #33 / #35。当日という値を根拠にしない（`period=custom` の 1 日にも効かせる）。 */
  it('(c) daily の分岐に isToday が現れない', () => {
    expect(dailyBranch).not.toContain('isToday');
  });

  /** (c) #33。`perDay` も同じ根拠。 */
  it('(c) perDay の分岐が days === 1 を根拠にしている', () => {
    expect(perDayBranch.replace(/\s+/g, '')).toContain('days===1');
  });

  /** (c) #33 / #35 */
  it('(c) perDay の分岐に isToday が現れない', () => {
    expect(perDayBranch).not.toContain('isToday');
  });

  /**
   * 設計 §7.2。**直帰率・平均滞在の注記は当日だけ。**
   *
   * 「進行中のセッションを含む」ことの説明であり、確定値である「昨日」には当てはまらない。
   * 一般化すると、確定値に対して嘘の注記が出る。
   */
  it('bounceRateNote / dwellAvgNote は isToday のまま', () => {
    expect(page).toMatch(/bounceRateNote:\s*isToday\s*\?/);
    expect(page).toMatch(/dwellAvgNote:\s*isToday\s*\?/);
  });

  /** 実装プラン §8 #7。既存の `days` を使う（新しい変数も新しい計算も足さない）。 */
  it('days は既存の rangeDays(period.from, period.to) のまま', () => {
    expect(page.replace(/\s+/g, '')).toContain('constdays=rangeDays(period.from,period.to)');
  });
});
