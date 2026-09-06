import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 共通部品の静的検査（031-chart-tooltip 設計 §13 / §10-D7 / §10-D8、
 * 要件 §6-1 の追加裁定）。
 *
 * `application/analytics/static-checks.test.ts` と
 * `application/jobs/static-checks.test.ts` と同じく、ソース・ファイルを読んで形を固定する。
 * **ここへ寄せるのは、実行時には見えない性質だけ。**
 *
 * `vitest.config.mts` にはバンドラの `'use client'` 解釈が無く、
 * `renderToStaticMarkup` から見れば `'use client'` は**ただの文字列リテラル**である。
 * どちらのファイルに書いても静的描画テストは同じように動くので、
 * **テストが通るかどうかでは要件 §6-1 の裁定を守れているか判定できない**（設計 §13.3）。
 *
 * 守らせたいのは次の 1 点である。
 *
 * > `chart.tsx` は Server Component のまま据え置き、
 * > `'use client'` は新しい子モジュール `chart-hover.tsx` に閉じ込める。
 *
 * `chart.tsx` を Client Component にすると、Plugin の Server Component が
 * `<Chart fallback={<Table … render={…} />} />` と書いたときに `fallback` が
 * server → client の境界を越え、`render` 関数を直列化できずに**実行時に落ちる**
 * （設計 §13.1）。`ui/plugin/plugin-boundary.tsx` の
 * 「Plugin 作者に『Client Component で書くこと』を要求しない」という約束が破れる。
 */

/** apps/web/src/ui/components */
const DIR = import.meta.dirname;

/**
 * 読めなければ**空文字を返す**（`describe` の本体で投げない）。
 *
 * 本体で投げるとファイルごと収集に失敗し、他の検査が 1 つも評価されない。
 * 「ファイルが無い」も `it` の中で 1 件ずつ落とす。
 */
function read(name: string): string {
  try {
    return readFileSync(join(DIR, name), 'utf8');
  } catch {
    return '';
  }
}

/** 先頭の非空行（`'use client'` のディレクティブはここに無ければ効かない）。 */
function firstNonEmptyLine(source: string): string {
  return (
    source
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  );
}

const chart = read('chart.tsx');
const chartHover = read('chart-hover.tsx');

/**
 * D8。`'use client'` は `chart-hover.tsx` の**先頭**にある。
 *
 * 引用符はどちらも許す（Prettier の設定が変わっても空振りしないように）。
 * 末尾のセミコロンの有無も問わない。
 */
describe("chart-hover.tsx に 'use client' がある（D8）", () => {
  /** 空振り防止。パスを間違えて空文字を読んでいると、ここが先に落ちる。 */
  it('chart-hover.tsx が読めて、ChartHoverLayer を export している', () => {
    expect(chartHover, 'chart-hover.tsx が読めない').not.toBe('');
    expect(chartHover).toContain('export function ChartHoverLayer(');
  });

  it('先頭の非空行が use client のディレクティブである', () => {
    expect(firstNonEmptyLine(chartHover)).toMatch(/^(['"])use client\1;?$/);
  });
});

/**
 * D7。`chart.tsx` は Server Component のままである。
 *
 * `use client` の語がファイルのどこにも現れないことで見る。
 * 先頭以外に書いてもディレクティブとしては効かないが、
 * **「戻そうとした跡」を残さない**ほうが後から読む人に伝わる。
 */
describe("chart.tsx に 'use client' が無い（D7）", () => {
  /** 空振り防止。 */
  it('chart.tsx が読めて、Chart を export している', () => {
    expect(chart, 'chart.tsx が読めない').not.toBe('');
    expect(chart).toContain('export function Chart(');
  });

  it('use client の語が 1 つも現れない', () => {
    expect(chart).not.toContain('use client');
  });

  /** 膜は `chart-hover.tsx` から借りる（`chart.tsx` に自前で書かない）。 */
  it('chart.tsx が ChartHoverLayer を chart-hover から import している', () => {
    expect(chart).toMatch(/from\s+['"]\.\/chart-hover['"]/);
    expect(chart).toContain('ChartHoverLayer');
  });
});

/**
 * F3（構造の側）。**有限性の規約を 2 つの経路に等しく置く**（設計 §5.4.2）。
 *
 * > `hover` に載せてよいのは、`xPercent` と `yPercent` がどちらも有限な点だけである。
 * > これは `chartHoverPoints`（1 系列）と `chartLayout`（複数系列）の**両方に等しく掛かる**。
 *
 * **`chartLayout` 側ではこのガードはいま 1 点も落とさない。**
 * `value` は 0 に潰れ、`niceMax` は必ず正の有限値を返すので、非有限な座標が生まれる経路が無い。
 * つまり**振る舞いの差が出ないので、実行時には「ガードが有るか無いか」を見分けられない**。
 * D7 / D8 と同じ理由でここへ寄せる。
 *
 * 置く理由は設計 §5.4.2 のとおり 2 つある。
 *
 * * 片方だけ壊れる形にしない。`yMax` の式が将来変われば `chartLayout` にも
 *   非有限な座標が生まれうる。そのとき `chartHoverPoints` にだけガードがあると、
 *   **同じ入力で片方の経路だけが静かに壊れる**
 * * `chartHitTest` の前提を入口で 1 つに固定できる。`chartHitTest` は点の側の有限性を
 *   見ないので、非有限な `yPercent` が混ざると「決して選ばれない点」または
 *   「必ず選ばれる点」になりうる
 */
describe('hover の有限性の規約を 2 経路に置く（F3 / 設計 §5.4.2）', () => {
  const geometry = read('chart-geometry.ts');

  /** `export function <name>(` から、次の `export ` の直前まで。無ければ空文字。 */
  function exportedFunctionBody(source: string, name: string): string {
    const start = source.indexOf(`export function ${name}(`);
    if (start < 0) {
      return '';
    }
    const rest = source.slice(start + 1);
    const next = rest.search(/^export /m);
    return next === -1 ? rest : rest.slice(0, next);
  }

  /**
   * **コメントを落としてから見る。** doc コメントに `Number.isFinite(x)` と
   * 書いただけで通ってしまう検査にしない（実際のコードに判定があることを見る）。
   */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  }

  const hoverPointsBody = withoutComments(exportedFunctionBody(geometry, 'chartHoverPoints'));
  const layoutBody = withoutComments(exportedFunctionBody(geometry, 'chartLayout'));

  /** 空振り防止。読めていて、両方の関数と `hover` を積む行が見つかること。 */
  it('chart-geometry.ts が読めて、両方の関数が見つかる', () => {
    expect(geometry, 'chart-geometry.ts が読めない').not.toBe('');
    expect(hoverPointsBody, 'chartHoverPoints が見つからない').not.toBe('');
    expect(layoutBody, 'chartLayout が見つからない').not.toBe('');
  });

  it('どちらの関数も hover の要素を組み立てている（検査が空振りしていない）', () => {
    expect(hoverPointsBody).toContain('xPercent');
    expect(hoverPointsBody).toContain('yPercent');
    expect(layoutBody).toContain('xPercent');
    expect(layoutBody).toContain('yPercent');
  });

  /** 1 系列の経路。ここには既にガードがある。 */
  it.each([
    ['x', /Number\.isFinite\(\s*x/],
    ['y', /Number\.isFinite\(\s*y/],
  ])('chartHoverPoints に %s の有限性の判定がある', (_axis, pattern) => {
    expect(hoverPointsBody).toMatch(pattern);
  });

  /**
   * 複数系列の経路。**同じ判定を置く。**
   *
   * `Number.isFinite(point.value)`（値を 0 に潰す既存の判定）とは別物である。
   * 見るのは**座標**（`x` / `xPercent`、`y` / `yPercent`）の有限性。
   */
  it.each([
    ['x', /Number\.isFinite\(\s*x/],
    ['y', /Number\.isFinite\(\s*y/],
  ])(
    'chartLayout にも %s の有限性の判定がある（いまは 1 点も落とさないガード）',
    (_axis, pattern) => {
      expect(layoutBody).toMatch(pattern);
    },
  );
});
