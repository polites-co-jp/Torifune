import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimeZoneChangePreview } from '@/application/analytics/timezone-use-cases';
import type { TimeZoneGroup } from '@/domain/analytics/time-zone';
import {
  TimeZoneChangeDetails,
  TimeZoneSettings,
  type TimeZoneSettingsProps,
} from './timezone-settings';

/**
 * 設定 → 一般の「基準タイムゾーン」の区画
 * （032-timezone-setting 設計 §7.1 / §7.2、受け入れ条件 #72〜#77、#96、#97）。
 *
 * 想定する props（実装プラン T16）：
 *
 * ```ts
 * TimeZoneSettings({
 *   current: string;
 *   source: 'database' | 'environment' | 'default';
 *   groups: readonly TimeZoneGroup[];
 *   canManage: boolean;
 *   // テストから確認ダイアログを開いた状態で描くための入口（既定は null）。
 *   initialPreview?: TimeZoneChangePreview | null;
 * })
 * ```
 *
 * 確認ダイアログの本文は `TimeZoneChangeDetails`（プレビューを props に取る純粋な部品）として
 * 同じファイルから named export する。押した後の HTML を決定的に検査するため（実装プラン §8 #H）。
 *
 * `apiRequest` は差し替える。**描画で要求が飛ばないこと**もここで見る。
 */

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/ui/client/api-client', () => ({
  apiRequest: api.request,
  apiUpload: vi.fn(),
  invalidateCsrfToken: vi.fn(),
  redirectToLogin: vi.fn(),
}));

const GROUPS: readonly TimeZoneGroup[] = [
  { region: 'UTC', options: [{ value: 'UTC', label: 'UTC (GMT+00:00)' }] },
  {
    region: 'Asia',
    options: [
      { value: 'Asia/Tokyo', label: 'Asia/Tokyo (GMT+09:00)' },
      { value: 'Asia/Seoul', label: 'Asia/Seoul (GMT+09:00)' },
    ],
  },
  {
    region: 'America',
    options: [{ value: 'America/Los_Angeles', label: 'America/Los_Angeles (GMT-07:00)' }],
  },
];

const PREVIEW: TimeZoneChangePreview = {
  timeZone: 'Asia/Tokyo',
  currentTimeZone: 'UTC',
  currentSource: 'environment',
  unchanged: false,
  rebuildFrom: '2025-08-01',
  rebuildTo: '2026-09-06',
  rebuildDays: 402,
  lostDays: 120,
  lostCoreRows: 8640,
  lostPluginRows: 420,
  lostSources: ['ga-import', 'ads-import'],
  lostSites: 3,
  lostFrom: '2025-01-01',
  lostTo: '2025-07-31',
};

const BASE: TimeZoneSettingsProps = {
  current: 'Asia/Tokyo',
  source: 'database',
  groups: GROUPS,
  canManage: true,
};

function render(overrides: Partial<TimeZoneSettingsProps> = {}): string {
  return renderToStaticMarkup(createElement(TimeZoneSettings, { ...BASE, ...overrides }));
}

function renderDetails(overrides: Partial<TimeZoneChangePreview> = {}): string {
  return renderToStaticMarkup(
    createElement(TimeZoneChangeDetails, { preview: { ...PREVIEW, ...overrides } }),
  );
}

/**
 * タグを落として文字だけにする。
 *
 * **桁区切りのカンマも落とす。** `8,640` と `8640` のどちらで出しても同じ検査で見られるようにする
 * （表記まで固定すると、文言の調整のたびにテストが壊れる）。
 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/(\d),(?=\d{3})/g, '$1');
}

afterEach(() => {
  api.request.mockReset();
});

describe('現在値と出所', () => {
  /** #72 */
  it.each([
    ['database', 'データベース'],
    ['environment', '環境変数'],
    ['default', '既定'],
  ] as const)('source = %s で「%s」と表示する', (source, label) => {
    const text = textOf(render({ source }));

    expect(text).toContain('Asia/Tokyo');
    expect(text).toContain(label);
  });

  /** #72。区画の見出しと、何を決める設定かの説明。 */
  it('見出し「基準タイムゾーン」と、1 日の境目を決める旨を出す', () => {
    const text = textOf(render());

    expect(text).toContain('基準タイムゾーン');
    expect(text).toContain('境目');
  });

  /** §7.1。選択欄は地域ごとの `<optgroup>`（418 件を平らに並べると探せない）。 */
  it('選択欄を optgroup で地域ごとにまとめる', () => {
    const html = render();

    expect(html).toContain('<optgroup');
    expect(html).toContain('label="Asia"');
    expect(html).toContain('value="Asia/Tokyo"');
    expect(textOf(html)).toContain('Asia/Tokyo (GMT+09:00)');
  });

  /** §7.1。現在値が選ばれた状態で描かれる。 */
  it('現在値が選択された状態になる', () => {
    const html = render({ current: 'America/Los_Angeles' });

    expect(html).toMatch(/<select[^>]*>/);
    expect(html).toMatch(/<option[^>]*value="America\/Los_Angeles"[^>]*selected/);
  });
});

describe('権限による表示制御', () => {
  /**
   * #73。**表示制御であって認可ではない**（認可は UseCase 側）。
   */
  it('canManage が false なら選択欄が disabled で、「変更する」ボタンが無い', () => {
    const html = render({ canManage: false });

    expect(html).toMatch(/<select[^>]*disabled/);
    expect(textOf(html)).not.toContain('変更する');
  });

  /** #73 の対。 */
  it('canManage が true なら選択欄は disabled でなく、「変更する」ボタンがある', () => {
    const html = render({ canManage: true });

    expect(html).not.toMatch(/<select[^>]*disabled/);
    expect(textOf(html)).toContain('変更する');
  });
});

describe('確認ダイアログ', () => {
  /** #74 */
  it('消える集計値の日数・行数と、計算し直す期間が本文に出る', () => {
    const text = textOf(render({ initialPreview: PREVIEW }));

    // 計算し直す期間。
    expect(text).toContain('2025-08-01');
    expect(text).toContain('2026-09-06');
    expect(text).toContain('402');
    // 消える集計値（サイト数 / 日数 / 期間）。
    expect(text).toContain('120');
    expect(text).toContain('3');
    expect(text).toContain('2025-01-01');
    expect(text).toContain('2025-07-31');
    // 出所ごとの行数。
    expect(text).toContain('8640');
    expect(text).toContain('420');
  });

  /** #74。どのタイムゾーンへ変えるのかが見出しで分かる。 */
  it('見出しに変更先のタイムゾーンが出る', () => {
    expect(textOf(render({ initialPreview: PREVIEW }))).toContain('Asia/Tokyo');
  });

  /**
   * #75。境界値。**消える集計値が 0 件でも同じダイアログを出す。**
   *
   * 訪問者数の断りは常に要る。
   */
  it('消える集計値が 0 件でもダイアログが出て「消える集計値：ありません」と書く', () => {
    const text = textOf(
      render({
        initialPreview: {
          ...PREVIEW,
          lostDays: 0,
          lostCoreRows: 0,
          lostPluginRows: 0,
          lostSites: 0,
          lostSources: [],
          lostFrom: null,
          lostTo: null,
        },
      }),
    );

    expect(text).toContain('消える集計値');
    expect(text).toContain('ありません');
    // 断りは消えない。
    expect(text).toContain('訪問者数');
  });

  /** §7.2。生ログが 1 行も無い環境。 */
  it('計算し直す期間が無いときは「ありません（生ログが残っていません）」と書く', () => {
    const text = textOf(renderDetails({ rebuildFrom: null, rebuildTo: null, rebuildDays: 0 }));

    expect(text).toContain('計算し直す期間');
    expect(text).toContain('生ログが残っていません');
  });

  /**
   * #76。要件 §2.1。**仕組み上どうにもならない**制約を先に伝える。
   */
  it('訪問者数・セッション数・直帰率・滞在時間が多めに出る旨が現れる', () => {
    const text = textOf(render({ initialPreview: PREVIEW }));

    for (const word of ['訪問者数', 'セッション数', '直帰率', '滞在時間']) {
      expect(text, word).toContain(word);
    }
    expect(text).toContain('多め');
  });

  /** #76。§6.3。変更した当日も同じ理由で多めに出る。 */
  it('変更した当日も多めに出る旨が現れる', () => {
    expect(textOf(renderDetails())).toContain('当日');
  });

  /** §7.2。プレビューは見積りである（間に生ログが消えると件数がずれる）。 */
  it('件数が見積りである旨と、進捗の見方が現れる', () => {
    const text = textOf(renderDetails());

    expect(text).toContain('見積');
    expect(text).toContain('定期実行');
  });

  /** #96。合計だけでは Plugin の値も消えることが読み取れない。 */
  it('Plugin が入れた値の行数と Plugin の ID が現れる', () => {
    const text = textOf(render({ initialPreview: PREVIEW }));

    expect(text).toContain('Plugin');
    expect(text).toContain('420');
    expect(text).toContain('ga-import');
    expect(text).toContain('ads-import');
  });

  /** #97。Core は作り直せるが、**Plugin の値は本体では作り直せない。** */
  it('lostPluginRows > 0 なら「永久に失われる」旨が現れる', () => {
    expect(textOf(renderDetails({ lostPluginRows: 420 }))).toContain('永久に失われ');
  });

  /** #97 の対。消えないなら断らない。 */
  it('lostPluginRows が 0 なら「永久に失われる」旨を出さない', () => {
    const text = textOf(renderDetails({ lostPluginRows: 0, lostSources: [] }));

    expect(text).not.toContain('永久に失われ');
  });

  /**
   * #77。**キャンセルすると保存の要求が飛ばない。**
   *
   * 描画の時点では 1 度も要求しない（数えるのは「変更する」を押したときだけ）。
   * キャンセルの導線があることも併せて見る。
   */
  it('ダイアログを開いた状態で描いても保存の要求は飛ばず、キャンセルの導線がある', () => {
    const text = textOf(render({ initialPreview: PREVIEW }));

    expect(api.request).not.toHaveBeenCalled();
    expect(text).toContain('キャンセル');
  });

  /** #77。区画をただ描くだけでも要求は飛ばない（画面の描画でプレビューを数えない。§7.2）。 */
  it('区画を描くだけでは要求が飛ばない', () => {
    render();

    expect(api.request).not.toHaveBeenCalled();
  });

  /** ダイアログを開いていなければ本文は出ない。 */
  it('initialPreview が無ければ確認ダイアログの本文は出ない', () => {
    const text = textOf(render());

    expect(text).not.toContain('訪問者数');
    expect(text).not.toContain('ga-import');
  });
});

/**
 * 追加 A：生ログが 1 行も無い環境（設計 §5.4.1、受け入れ条件 #121）。
 *
 * **何も消えなくなった。** 初版は「生ログが 1 行も無い環境では集計値がすべて消える」
 * としてダイアログで強調していたが、§5.4.1 で**対象になるサイトが 1 つも無い**ため
 * 1 行も消えない。ダイアログは「消える集計値：ありません」を出す。
 */
describe('生ログが 1 行も無い環境の確認ダイアログ', () => {
  /** そういう環境のプレビュー（洗い替える期間も、消える集計値も無い）。 */
  const NOTHING_TO_LOSE = {
    rebuildFrom: null,
    rebuildTo: null,
    rebuildDays: 0,
    lostDays: 0,
    lostCoreRows: 0,
    lostPluginRows: 0,
    lostSites: 0,
    lostSources: [],
    lostFrom: null,
    lostTo: null,
  } as const;

  /** #121 */
  it('「消える集計値：ありません」が出る', () => {
    const text = textOf(render({ initialPreview: { ...PREVIEW, ...NOTHING_TO_LOSE } }));

    expect(text).toContain('消える集計値');
    expect(text).toContain('ありません');
  });

  /** #121。消えないので、Plugin の断りも出さない。 */
  it('Plugin の ID も「永久に失われる」旨も出さない', () => {
    const text = textOf(renderDetails(NOTHING_TO_LOSE));

    expect(text).not.toContain('ga-import');
    expect(text).not.toContain('永久に失われ');
  });

  /** #121。訪問者数の断りは、消える集計値が無くても常に要る（§7.2）。 */
  it('訪問者数の断りは出す', () => {
    const text = textOf(render({ initialPreview: { ...PREVIEW, ...NOTHING_TO_LOSE } }));

    expect(text).toContain('訪問者数');
    expect(text).toContain('多め');
  });
});
