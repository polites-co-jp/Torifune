import { describe, expect, it } from 'vitest';
import type { AnalyticsPoint } from './analytics';
import {
  botShare,
  breakdownFromPoints,
  campaignProgress,
  delta,
  deltaPt,
  summarize,
} from './summary';

/**
 * 期間合計・Bot 合算・前期間比較・KPI 計算（028-analytics-dashboard-redesign 設計 §7.2 / §7.3.4 / §7.3.5、
 * 受け入れ条件 #56〜#62）。
 *
 * 想定するシグネチャ（設計書の表と計算式から決めた最小の形。implementer はこれに合わせる）：
 *
 * ```ts
 * interface Summary {
 *   pageviews: number;            // オフ: pageviews / オン: pageviews + bot_pageviews
 *   visitors: number;             // オフ: visitors  / オン: visitors + bot_visitors
 *   sessions: number;             // オフ: sessions  / オン: sessions + bot_pageviews
 *   bounces: number;              // オフ: bounces   / オン: bounces + bot_pageviews
 *   bounceRate: number | null;    // bounces / sessions（0〜1）。分母 0 は null
 *   dwellAvg: number | null;      // dwell_ms / dwell_samples（ms）。分母 0 は null。Bot は標本に入らない
 *   perVisitor: number | null;    // pageviews / visitors。分母 0 は null
 * }
 * summarize(points: readonly AnalyticsPoint[], options: { includeBots: boolean }): Summary
 *   - key === '' の点だけを、日と出所をまたいで足す。知らない指標は無視する
 *
 * delta(cur: number, prev: number, lowerIsBetter?: boolean): { text: string; tone: 'success' | 'danger' | 'muted' }
 * deltaPt(cur: number | null, prev: number | null, lowerIsBetter?: boolean): { text: string; tone: ... }
 *   - 率は 0〜1。分母 0（summarize が null を返した側）は '—'
 *
 * botShare(points: readonly AnalyticsPoint[]): {
 *   botPageviews: number;         // bot_pageviews
 *   humanPageviews: number;       // pageviews
 *   share: number | null;         // bot_pageviews / (pageviews + bot_pageviews)。分母 0 は null
 *   peakDay: string | null;       // 日次 bot_pageviews の最大の日（同数なら早い日）。無ければ null
 * }
 *   - 「Bot を集計に含める」スイッチの引数を持たない（§7.3.4「スイッチに左右されない」）
 *
 * campaignProgress(startsOn: string, endsOn: string | null, today: string): {
 *   percent: number | null;       // (today − startsOn + 1) / (endsOn − startsOn + 1) × 100。100 で頭打ち。endsOn 無しは null
 *   text: string;                 // endsOn 無しは 'N 日目 · 終了日未定'
 * }
 * ```
 *
 * 記号は設計書のとおり：負号は U+2212（−）、分母 0 は U+2014（—）、区切りは U+00B7（·）。
 */

const MINUS = '−';
const EM_DASH = '—';
const MIDDLE_DOT = '·';

function point(
  metric: string,
  value: number,
  overrides: Partial<Pick<AnalyticsPoint, 'key' | 'metricDate' | 'source' | 'siteId'>> = {},
): AnalyticsPoint {
  return {
    siteId: overrides.siteId ?? 'site-1',
    metricDate: overrides.metricDate ?? '2026-06-01',
    source: overrides.source ?? 'core',
    metric,
    key: overrides.key ?? '',
    value,
  };
}

/** 2 日分に分けて入れ、日をまたいで足すことも同時に確かめる。 */
const BASE_POINTS: readonly AnalyticsPoint[] = [
  point('pageviews', 600, { metricDate: '2026-06-01' }),
  point('pageviews', 400, { metricDate: '2026-06-02' }),
  point('visitors', 300),
  point('sessions', 400),
  point('bounces', 100),
  point('dwell_ms', 600_000),
  point('dwell_samples', 300),
  point('bot_pageviews', 50),
  point('bot_visitors', 20),
];

describe('summarize', () => {
  /** #56（オフ列） */
  it('Bot を含めないとき、人の値だけを足す', () => {
    const summary = summarize(BASE_POINTS, { includeBots: false });

    expect(summary.pageviews).toBe(1000);
    expect(summary.visitors).toBe(300);
    expect(summary.sessions).toBe(400);
    expect(summary.bounces).toBe(100);
    expect(summary.bounceRate).toBeCloseTo(0.25, 10);
    expect(summary.dwellAvg).toBeCloseTo(2000, 10);
    expect(summary.perVisitor).toBeCloseTo(1000 / 300, 10);
  });

  /** #56（オン列）。Bot は「1 アクセス = 1 セッション = 直帰」。 */
  it('Bot を含めるとき、PV・訪問者・セッション・直帰に Bot を足す', () => {
    const summary = summarize(BASE_POINTS, { includeBots: true });

    expect(summary.pageviews).toBe(1050);
    expect(summary.visitors).toBe(320);
    expect(summary.sessions).toBe(450);
    expect(summary.bounces).toBe(150);
    expect(summary.bounceRate).toBeCloseTo(150 / 450, 10);
    expect(summary.perVisitor).toBeCloseTo(1050 / 320, 10);
  });

  /** #56。Bot は滞在の標本に入らないので、平均滞在はスイッチで変わらない。 */
  it('Bot を含めても平均滞在は変わらない', () => {
    const off = summarize(BASE_POINTS, { includeBots: false });
    const on = summarize(BASE_POINTS, { includeBots: true });

    expect(on.dwellAvg).toBe(off.dwellAvg);
  });

  /** §7.3.3 / §7.2。出所をまたいで足す（Plugin が同名の指標を取り込んだ値も表示に入る）。 */
  it('出所をまたいで足す', () => {
    const summary = summarize(
      [
        point('pageviews', 10, { source: 'core' }),
        point('pageviews', 5, { source: 'com.example.ga' }),
      ],
      { includeBots: false },
    );

    expect(summary.pageviews).toBe(15);
  });

  /** #57 */
  it('sessions が 0 なら直帰率は null', () => {
    const summary = summarize([point('pageviews', 3), point('bounces', 0), point('sessions', 0)], {
      includeBots: false,
    });

    expect(summary.bounceRate).toBeNull();
  });

  /** #57 */
  it('dwell_samples が 0 なら平均滞在は null', () => {
    const summary = summarize([point('dwell_ms', 0), point('dwell_samples', 0)], {
      includeBots: false,
    });

    expect(summary.dwellAvg).toBeNull();
  });

  /** #57 */
  it('visitors が 0 なら訪問者あたり PV は null', () => {
    const summary = summarize([point('pageviews', 0), point('visitors', 0)], {
      includeBots: false,
    });

    expect(summary.perVisitor).toBeNull();
  });

  /** #57。点が 1 つも無い期間でも落ちない。 */
  it('点が無ければ 0 と null', () => {
    const summary = summarize([], { includeBots: false });

    expect(summary.pageviews).toBe(0);
    expect(summary.visitors).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.bounceRate).toBeNull();
    expect(summary.dwellAvg).toBeNull();
    expect(summary.perVisitor).toBeNull();
  });

  /** #57。Bot だけの日（sessions = 0, bot_pageviews > 0）は、Bot を含めると率が出る。 */
  it('Bot だけの日は、Bot を含めたときだけ直帰率が出る', () => {
    const points = [
      point('pageviews', 0),
      point('sessions', 0),
      point('bounces', 0),
      point('bot_pageviews', 4),
    ];

    expect(summarize(points, { includeBots: false }).bounceRate).toBeNull();
    expect(summarize(points, { includeBots: true }).bounceRate).toBeCloseTo(1, 10);
  });

  /** #58 */
  it('知らない指標名を無視する', () => {
    const withUnknown = summarize([...BASE_POINTS, point('conversions', 500)], {
      includeBots: false,
    });

    expect(withUnknown).toEqual(summarize(BASE_POINTS, { includeBots: false }));
  });

  /** #58。パス別などの key 付きの点は合計に混ぜない。 */
  it('key が空でない点を無視する', () => {
    const withKeyed = summarize(
      [
        ...BASE_POINTS,
        point('pageviews', 99, { key: '/a' }),
        point('path_pageviews', 99, { key: '/a' }),
        point('bot_pageviews', 99, { key: '/a' }),
      ],
      { includeBots: true },
    );

    expect(withKeyed).toEqual(summarize(BASE_POINTS, { includeBots: true }));
  });
});

describe('delta', () => {
  /** #59 */
  it('増えたら + と success', () => {
    expect(delta(110, 100)).toEqual({ text: '+10.0%', tone: 'success' });
  });

  /** #59。負号は U+2212。 */
  it('減ったら − と danger', () => {
    expect(delta(90, 100)).toEqual({ text: `${MINUS}10.0%`, tone: 'danger' });
  });

  /** #59。直帰率のように「下がると良い」指標では色が反転する。 */
  it('lowerIsBetter なら減って success', () => {
    expect(delta(90, 100, true)).toEqual({ text: `${MINUS}10.0%`, tone: 'success' });
  });

  it('lowerIsBetter なら増えて danger', () => {
    expect(delta(110, 100, true).tone).toBe('danger');
  });

  /** #59 */
  it('変化が無ければ +0.0% と muted', () => {
    expect(delta(100, 100)).toEqual({ text: '+0.0%', tone: 'muted' });
  });

  /** #59。前期 0 は比を出せない。 */
  it('前期が 0 なら — と muted', () => {
    expect(delta(5, 0)).toEqual({ text: EM_DASH, tone: 'muted' });
  });

  /** §7.3.5。|d| < 0.0005 は muted。 */
  it('0.05% 未満の差は muted', () => {
    expect(delta(10004, 10000).tone).toBe('muted');
    expect(delta(9996, 10000).tone).toBe('muted');
  });

  it('0.05% 以上の差は色が付く', () => {
    expect(delta(10005, 10000).tone).toBe('success');
    expect(delta(9995, 10000).tone).toBe('danger');
  });

  it('小数 1 桁に丸める', () => {
    expect(delta(1004, 1000).text).toBe('+0.4%');
    expect(delta(1234, 1000).text).toBe('+23.4%');
  });

  /** 平均滞在のような小数の値でも同じ規則。 */
  it('小数の値でも比を出す', () => {
    expect(delta(2.5, 2)).toEqual({ text: '+25.0%', tone: 'success' });
  });
});

describe('deltaPt', () => {
  /** #60。直帰率は下がると緑（lowerIsBetter の既定は true）。 */
  it('率が下がったら −pt と success', () => {
    expect(deltaPt(0.45, 0.5)).toEqual({ text: `${MINUS}5.0pt`, tone: 'success' });
  });

  /** #60 */
  it('率が上がったら +pt と danger', () => {
    expect(deltaPt(0.55, 0.5)).toEqual({ text: '+5.0pt', tone: 'danger' });
  });

  /** #60。|d| < 0.05pt は muted。 */
  it('0.05pt 未満の差は muted', () => {
    expect(deltaPt(0.5004, 0.5).tone).toBe('muted');
  });

  it('変化が無ければ +0.0pt と muted', () => {
    expect(deltaPt(0.5, 0.5)).toEqual({ text: '+0.0pt', tone: 'muted' });
  });

  /** #60。前期の分母（sessions）が 0 → summarize は null を返す → '—'。 */
  it('前期が無ければ — と muted', () => {
    expect(deltaPt(0.45, null)).toEqual({ text: EM_DASH, tone: 'muted' });
  });

  it('当期が無ければ — と muted', () => {
    expect(deltaPt(null, 0.5)).toEqual({ text: EM_DASH, tone: 'muted' });
  });

  it('lowerIsBetter を false にすると上がって success', () => {
    expect(deltaPt(0.55, 0.5, false).tone).toBe('success');
  });

  it('小数 1 桁に丸める', () => {
    expect(deltaPt(0.4627, 0.5).text).toBe(`${MINUS}3.7pt`);
  });
});

describe('botShare', () => {
  const points: readonly AnalyticsPoint[] = [
    point('pageviews', 600, { metricDate: '2026-06-01' }),
    point('pageviews', 400, { metricDate: '2026-06-02' }),
    point('bot_pageviews', 5, { metricDate: '2026-06-01' }),
    point('bot_pageviews', 9, { metricDate: '2026-06-02' }),
    point('bot_pageviews', 9, { metricDate: '2026-06-03' }),
    point('bot_pageviews', 27, { metricDate: '2026-06-04' }),
  ];

  /** #61。割合 = bot / (pageviews + bot)。 */
  it('Bot の PV・人の PV・割合を返す', () => {
    const share = botShare(points);

    expect(share.botPageviews).toBe(50);
    expect(share.humanPageviews).toBe(1000);
    expect(share.share).toBeCloseTo(50 / 1050, 10);
  });

  /** #61。「Bot を集計に含める」のオン／オフで変わらない。人の PV に Bot を足さない。 */
  it('スイッチに左右されない（summarize のオンと違い、人の PV に Bot を足さない）', () => {
    const share = botShare(points);
    const on = summarize(points, { includeBots: true });

    expect(on.pageviews).toBe(1050);
    expect(share.humanPageviews).toBe(1000);
    expect(share.share).toBeCloseTo(50 / 1050, 10);
  });

  /** #61。最多日は日次 bot_pageviews の最大の日。 */
  it('最も多かった日を返す', () => {
    expect(botShare(points).peakDay).toBe('2026-06-04');
  });

  /** #61。同数なら早い日。 */
  it('同数なら早い日', () => {
    const tied = points.filter((p) => p.metricDate !== '2026-06-04');

    expect(botShare(tied).peakDay).toBe('2026-06-02');
  });

  /** 並びに依存しない。 */
  it('点の並び順に左右されない', () => {
    const reversed = [...points].reverse();

    expect(botShare(reversed).peakDay).toBe('2026-06-04');
  });

  it('Bot が無ければ 0 と null', () => {
    const share = botShare([point('pageviews', 10)]);

    expect(share.botPageviews).toBe(0);
    expect(share.share).toBeCloseTo(0, 10);
    expect(share.peakDay).toBeNull();
  });

  /** 分母 0 の率は出さない。 */
  it('PV が 1 件も無ければ割合は null', () => {
    const share = botShare([]);

    expect(share.share).toBeNull();
    expect(share.peakDay).toBeNull();
  });

  /** key 付きの点（あれば）は混ぜない。 */
  it('key が空でない点を無視する', () => {
    const share = botShare([...points, point('bot_pageviews', 999, { key: '/a' })]);

    expect(share.botPageviews).toBe(50);
  });
});

describe('campaignProgress', () => {
  /** #62。進行 = (today − startsOn + 1) / (endsOn − startsOn + 1)。 */
  it('経過日数 / 総日数 を % で返す', () => {
    expect(campaignProgress('2026-04-01', '2026-04-30', '2026-04-15').percent).toBeCloseTo(50, 10);
  });

  /** #62。初日は 1 日目として数える。 */
  it('初日は 1 / 総日数', () => {
    expect(campaignProgress('2026-04-01', '2026-04-10', '2026-04-01').percent).toBeCloseTo(10, 10);
  });

  /** #62 */
  it('最終日で 100', () => {
    expect(campaignProgress('2026-04-01', '2026-04-10', '2026-04-10').percent).toBeCloseTo(100, 10);
  });

  /** #62。100 で頭打ち。 */
  it('終了日を過ぎても 100 を超えない', () => {
    expect(campaignProgress('2026-04-01', '2026-04-10', '2026-05-10').percent).toBe(100);
  });

  /** #62 */
  it('終了日が無ければ「N 日目 · 終了日未定」', () => {
    const progress = campaignProgress('2026-04-01', null, '2026-04-15');

    expect(progress.percent).toBeNull();
    expect(progress.text).toBe(`15 日目 ${MIDDLE_DOT} 終了日未定`);
  });

  /** #62。1 日だけのキャンペーン。 */
  it('開始日と終了日が同じなら初日で 100', () => {
    expect(campaignProgress('2026-04-01', '2026-04-01', '2026-04-01').percent).toBe(100);
  });
});

/**
 * 点の集合から内訳を作る純関数（030-analytics-today 設計 §12.2、受け入れ条件 #12〜#17）。
 *
 * ```ts
 * breakdownFromPoints(points: readonly AnalyticsPoint[], metric: string): readonly BreakdownItem[]
 * ```
 *
 * 当日タブは `analytics`（確定値）を読まず、生ログから作った点だけを見る（設計 §13-3）。
 * 内訳（ページ・参照元・時間帯・デバイス）を確定期間と**同じ行順**で出すために、
 * Repository の `sumByKey`（`ORDER BY sum(value) DESC, key ASC`）と並びを一致させる。
 *
 * - 指定した `metric` の点を `key` ごとに合算する（`key === ''` は含めない）
 * - 並び順は `value` 降順、同値なら `key` 昇順
 * - 出所（`source`）はまたいで合算する（現行の内訳と同じ規則）
 * - 空配列・未知の指標・全部 0 を通す（落ちない）
 */
describe('breakdownFromPoints', () => {
  /** #12。出所をまたいで足す（Plugin が取り込んだ同名の指標も内訳に入る）。 */
  it('同じ metric・同じ key の点が複数の出所にあれば、合算した 1 行になる', () => {
    const points = [
      point('path_pageviews', 3, { key: '/a', source: 'core' }),
      point('path_pageviews', 4, { key: '/a', source: 'ga4' }),
    ];

    expect(breakdownFromPoints(points, 'path_pageviews')).toEqual([{ key: '/a', value: 7 }]);
  });

  /** #12。日もまたいで足す。 */
  it('日をまたいで合算する', () => {
    const points = [
      point('path_pageviews', 2, { key: '/a', metricDate: '2026-06-01' }),
      point('path_pageviews', 5, { key: '/a', metricDate: '2026-06-02' }),
    ];

    expect(breakdownFromPoints(points, 'path_pageviews')).toEqual([{ key: '/a', value: 7 }]);
  });

  /** #13。`sumByKey` の `ORDER BY sum(value) DESC, key ASC` と一致させる。 */
  it('value 降順に並ぶ', () => {
    const points = [
      point('referrer', 1, { key: 'a.example' }),
      point('referrer', 9, { key: 'b.example' }),
      point('referrer', 5, { key: 'c.example' }),
    ];

    expect(breakdownFromPoints(points, 'referrer').map((item) => item.key)).toEqual([
      'b.example',
      'c.example',
      'a.example',
    ]);
  });

  /** #13。同値の並びが揺れると、当日と確定期間で行の順番が変わる。 */
  it('同値なら key 昇順に並ぶ', () => {
    const points = [
      point('referrer', 3, { key: 'c.example' }),
      point('referrer', 3, { key: 'a.example' }),
      point('referrer', 3, { key: 'b.example' }),
    ];

    expect(breakdownFromPoints(points, 'referrer').map((item) => item.key)).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ]);
  });

  /** #14。同じ key を持つ別の指標を混ぜない。 */
  it('指定した metric 以外の点を含めない', () => {
    const points = [
      point('path_pageviews', 3, { key: '/a' }),
      point('path_visitors', 100, { key: '/a' }),
    ];

    expect(breakdownFromPoints(points, 'path_pageviews')).toEqual([{ key: '/a', value: 3 }]);
  });

  /** #15。`key === ''` は期間合計（`summarize` の担当）であって内訳の 1 行ではない。 */
  it("key === '' の点を含めない", () => {
    const points = [point('pageviews', 10, { key: '' }), point('pageviews', 4, { key: '/a' })];

    expect(breakdownFromPoints(points, 'pageviews')).toEqual([{ key: '/a', value: 4 }]);
  });

  /** #15。`key === ''` しか無ければ空配列。 */
  it("key === '' しか無ければ空配列", () => {
    expect(breakdownFromPoints([point('pageviews', 10, { key: '' })], 'pageviews')).toEqual([]);
  });

  /** #16 */
  it('空配列を渡すと空配列', () => {
    expect(breakdownFromPoints([], 'path_pageviews')).toEqual([]);
  });

  /** #16。知らない指標でも落ちない（Plugin が任意の指標名を入れられる）。 */
  it('未知の metric を渡しても落ちず空配列', () => {
    expect(breakdownFromPoints(BASE_POINTS, 'no_such_metric')).toEqual([]);
  });

  /** #17。0 の行を落とすと、確定期間と当日で行の数が変わる。 */
  it('すべての値が 0 でも行は出て、値は 0 のまま', () => {
    const points = [
      point('pageviews_device', 0, { key: 'mobile' }),
      point('pageviews_device', 0, { key: 'desktop' }),
    ];

    expect(breakdownFromPoints(points, 'pageviews_device')).toEqual([
      { key: 'desktop', value: 0 },
      { key: 'mobile', value: 0 },
    ]);
  });
});
