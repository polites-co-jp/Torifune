import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 基準タイムゾーンの解決経路の静的検査
 * （032-timezone-setting 設計 §6.1.1 / §6.1.4、受け入れ条件 #29、#85、#88。実装プラン T9）。
 *
 * ここへ寄せるのは、**実行時には再現しにくい／数えられない**性質だけ。
 *
 * * **移行漏れ。** 同期版 `analyticsTimeZone()` を使い続けた経路だけが古い境目で動く。
 *   ログにも例外にも出ず、「プロセスによって集計日が違う」という壊れ方になる
 * * **ホットパスの問い合わせが増えていない。** 問い合わせを実行時に数える仕組みが
 *   本体にもテスト支援にも無い（`Connection` の抽象へ計測用の口を足すことになる）
 * * `rollupAnalytics` の呼び出しが変わっていない（#88）
 */

/** apps/web/src/application/analytics → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');

function read(...segments: string[]): string {
  return readFileSync(join(SRC_DIR, ...segments), 'utf8');
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** `apps/web/src` 配下の製品ファイル（`*.test.ts(x)` を除く）。 */
function productionFiles(dir: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'test-support') {
        continue;
      }
      found.push(...productionFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** `export function 名前(` から次の `export ` までを取り出す。無ければ空文字。 */
function exportedFunctionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^export (async )?function ${name}\\b`, 'm'));
  if (start < 0) {
    return '';
  }
  const rest = source.slice(start + 1);
  const next = rest.search(/^export /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** そのファイルが `@/application/analytics/timezone`（または相対）から取っている名前。 */
function timeZoneImports(source: string): string[] {
  const pattern =
    /import\s*\{([\s\S]*?)\}\s*from\s*['"](?:@\/application\/analytics\/timezone|\.\/timezone)['"]/g;
  return [...withoutComments(source).matchAll(pattern)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('type ')),
  );
}

/** 設計 §6.1.1 の表で、非同期版へ移す 8 ファイル。 */
const ASYNC_CALLERS: readonly string[] = [
  join('application', 'analytics', 'rollup.ts'),
  join('application', 'analytics', 'analytics-use-cases.ts'),
  join('application', 'jobs', 'definitions.ts'),
  join('app', 'analytics', 'page.tsx'),
  join('app', 'dashboard', 'page.tsx'),
  join('app', 'settings', 'page.tsx'),
  join('app', 'campaigns', '[id]', 'analytics', 'page.tsx'),
  join('app', 'api', 'v1', 'analytics', 'rollup', 'route.ts'),
];

/**
 * (a) #29 / #85。**同期版を import してよいのは `collect.ts` だけ。**
 *
 * これが移行漏れの検査そのもの。同期版はキャッシュを読むだけで DB を読まないため、
 * 使い続けた経路は最大 30 秒（TTL）古い境目のままになる。
 */
describe('同期版 analyticsTimeZone の使い道（#29 / #85）', () => {
  const offenders = productionFiles()
    .filter((path) => {
      const relativePath = relative(SRC_DIR, path);
      if (relativePath === join('application', 'analytics', 'timezone.ts')) {
        return false;
      }
      return timeZoneImports(readFileSync(path, 'utf8')).includes('analyticsTimeZone');
    })
    .map((path) => relative(SRC_DIR, path).split(sep).join('/'))
    .sort();

  it('同期版を import している製品ファイルは application/analytics/collect.ts だけ', () => {
    expect(offenders).toEqual(['application/analytics/collect.ts']);
  });

  /** (b) ホットパスで `await` しない。`collect` の 1 リクエストの問い合わせを増やさない。 */
  it('collect.ts が resolveAnalyticsTimeZone を import していない', () => {
    expect(timeZoneImports(read('application', 'analytics', 'collect.ts'))).not.toContain(
      'resolveAnalyticsTimeZone',
    );
  });

  /** (c) 同期版の本文に `await` が無い（DB を読む経路を持たない）。 */
  it('timezone.ts の analyticsTimeZone の本文に await が無い', () => {
    const body = exportedFunctionBody(
      withoutComments(read('application', 'analytics', 'timezone.ts')),
      'analyticsTimeZone',
    );

    expect(body, 'analyticsTimeZone が見つからない').not.toBe('');
    expect(body).not.toMatch(/\bawait\b/);
  });

  /** (c)。同期であることを宣言でも固定する。 */
  it('analyticsTimeZone は async でない', () => {
    const source = withoutComments(read('application', 'analytics', 'timezone.ts'));

    expect(source).toMatch(/export function analyticsTimeZone\s*\(/);
    expect(source).not.toMatch(/export async function analyticsTimeZone\s*\(/);
  });

  /** キャッシュは `processState` に置く（モジュール変数にしない。§6.1.2）。 */
  it('timezone.ts のキャッシュが processState に置かれている', () => {
    const source = withoutComments(read('application', 'analytics', 'timezone.ts'));

    expect(source).toContain('processState');
    expect(source).toMatch(/processState\(\s*['"]analytics\.time-zone['"]/);
  });
});

/**
 * (d) #85。**検査が空振りしていないことの担保。**
 *
 * (a) は「同期版を import していない」ことしか見ない。呼び出しごと消えていても通ってしまう。
 * 設計 §6.1.1 の表の 8 ファイルが、実際に非同期版へ移っていることを別に見る。
 */
describe('非同期版へ移った呼び出し元（#85）', () => {
  it.each(ASYNC_CALLERS.map((path) => [path.split(sep).join('/'), path] as const))(
    '%s が resolveAnalyticsTimeZone を使う',
    (_label, path) => {
      const source = withoutComments(readFileSync(join(SRC_DIR, path), 'utf8'));

      expect(source).toContain('resolveAnalyticsTimeZone');
    },
  );
});

/**
 * (e) #88。`rollupAnalytics` を `timeZone` 無しで呼んだ結果が従来と同じ。
 *
 * 030 の `static-checks.test.ts` と同じ趣旨。`aggregateDailyBreakdown` へ渡す引数に
 * `siteId` / `statementTimeoutMs` が混ざると、定期実行が 1 サイトに絞られたり
 * 5 秒で打ち切られたりする。
 */
describe('rollupAnalytics の呼び出しが変わらない（#88）', () => {
  const rollup = withoutComments(read('application', 'analytics', 'rollup.ts'));
  const windowLine = /const window\s*=\s*(\{[^}]*\})/.exec(rollup)?.[1] ?? '';

  it('window の組み立てが見つかる（検査が空振りしていない）', () => {
    expect(windowLine, 'const window = { … } が見つからない').not.toBe('');
    expect(rollup).toMatch(/aggregateDailyBreakdown\(\s*connection\s*,\s*window\s*\)/);
  });

  it.each(['siteId', 'statementTimeoutMs'])('window に %s が入っていない', (forbidden) => {
    expect(windowLine).not.toContain(forbidden);
  });

  it('window は範囲とタイムゾーンだけを持つ', () => {
    expect(windowLine).toMatch(/\{\s*\.\.\.range,\s*timeZone:/);
  });

  /** `timeZone` は引数で受け、省略時だけ解決する（走行中に境目が変わっても揺れない。§6.2.2）。 */
  it('rollupAnalytics が timeZone を任意の引数で受け、省略時に resolveAnalyticsTimeZone へ落ちる', () => {
    expect(rollup).toContain('timeZone?');
    expect(rollup).toMatch(/timeZone\s*\?\?\s*\(?\s*await resolveAnalyticsTimeZone\(\)/);
  });
});

/**
 * 境目の計算（`day.ts`）は 1 文字も変えない（#86 の前提。設計 §4）。
 *
 * 変えると `presetRange` / `todayInTimeZone` の既存テストの意味が変わる。
 */
describe('day.ts を変えない（#86）', () => {
  const day = withoutComments(read('domain', 'analytics', 'day.ts'));

  it.each([
    'isValidTimeZone',
    'dateInTimeZone',
    'todayInTimeZone',
    'daysAgoInTimeZone',
    'shiftDays',
    'presetRange',
    'previousRange',
  ])('day.ts が %s を export したままである', (name) => {
    expect(day).toMatch(new RegExp(`export function ${name}\\b`));
  });

  /** 名前の扱いは `time-zone.ts` へ分ける。`day.ts` に混ぜない。 */
  it.each(['canonicalTimeZone', 'listTimeZones', 'isSelectableTimeZone', 'timeZoneOptions'])(
    'day.ts に %s が無い',
    (name) => {
      expect(day).not.toContain(name);
    },
  );

  /** Domain は設定を読まない（`day.ts` の doc がそう宣言している）。 */
  it('day.ts が環境変数にも Application にも触れない', () => {
    expect(day).not.toContain('process.env');
    expect(day).not.toMatch(/from ['"]@\/application/);
  });
});

/**
 * #105 の構造側（設計 §7.3 / 実装プラン T17）。
 *
 * 「定期実行」の区画は `system.manage` を持つときだけ描く。**新しい分岐を足さない。**
 */
describe('定期実行の区画の出し分け（#105）', () => {
  const page = withoutComments(read('app', 'settings', 'page.tsx'));

  it('settings/page.tsx が canManageSystem で JobStatusSection を包んでいる', () => {
    expect(page).toMatch(/canManageSystem\s*&&\s*<JobStatusSection/);
  });

  /** 基準タイムゾーンの区画は誰にでも描く（変更できるかは `canManage` で渡す。§7.1）。 */
  it('settings/page.tsx が TimeZoneSettings を描き、canManage を渡す', () => {
    expect(page).toContain('TimeZoneSettings');
    expect(page).toMatch(/canManage=\{canManageSystem\}/);
  });

  /**
   * #100〜#104 の判定の置き場（設計 §7.3.1、実装プラン T17）。
   *
   * 再実行ボタンを出す条件は「**直近の実行が `ok` でないとき**」。
   * 判定は `page.tsx` が組み立てて `canRetry` として渡す（UI 部品は渡された値で描くだけ）。
   */
  it('settings/page.tsx が canRetry を lastRun の状態から組み立てる', () => {
    expect(page).toContain('canRetry');
    expect(page).toContain('completedThrough');
    // 「`ok` でないとき」という条件が判定に現れている。
    expect(page).toMatch(/canRetry[\s\S]{0,200}'ok'/);
  });

  /** 洗い替え以外の行に再実行の導線を出さない（#100 の対）。 */
  it('settings/page.tsx が洗い替えのジョブ名で判定している', () => {
    expect(page).toContain('analytics.timezoneRebuild');
  });
});

/**
 * 追加 F：`GET /api/v1/settings` の応答を許可リストで組み立てる
 * （設計 §6.5.1、受け入れ条件 #145）。
 *
 * `getSystemSettings` は `permission: null` で、**Cookie 無しでも叩ける**。
 * Domain の型をそのまま返すと、**設定が増えるたびに自動的に未認証へ公開される。**
 *
 * 塞ぐのは 032 が足した項目だけでなく、**次に設定を足す人が同じ穴を開ける構造**でもある。
 */
describe('GET /api/v1/settings の応答（#153）', () => {
  const route = withoutComments(read('app', 'api', 'v1', 'settings', 'route.ts'));

  it('GET の応答に analyticsTimeZone が現れない', () => {
    expect(route).not.toContain('analyticsTimeZone');
  });

  /**
   * #153。**許可リストをルートで組み立て直さない。**
   *
   * 判断の置き場が Domain の射影型とルートの 2 か所にあると、片方だけ直る。
   * ルートは UseCase の戻り値をそのまま返してよく、漏れないことは型が担保する（§6.5.1）。
   */
  it('GET が UseCase の戻り値をそのまま返している（ルートに許可リストを持たない）', () => {
    // 正規表現にせず素の部分文字列で見る（エスケープの取り違えで意味が変わらないように）。
    expect(route).toContain('dataResponse(await getSystemSettings(');
  });
});

/**
 * #145。設定画面は `GET /api/v1/settings` に依存していない。
 *
 * 画面は値と**出所**の両方が要るが、この API はそもそも出所を返さない。
 * Server Component から `analyticsTimeZoneSetting()` を直接呼ぶ。
 */
describe('設定画面はタイムゾーンを UseCase から取る（#145）', () => {
  const page = withoutComments(read('app', 'settings', 'page.tsx'));

  it('settings/page.tsx が analyticsTimeZoneSetting を呼ぶ', () => {
    expect(page).toContain('analyticsTimeZoneSetting');
  });

  /** `getSystemSettings` の戻り値からタイムゾーンを読まない（出所が付かない）。 */
  it('settings/page.tsx が settings.analyticsTimeZone を読まない', () => {
    expect(page).not.toContain('settings.analyticsTimeZone');
  });
});

/**
 * 追加 G：認可の文脈を持たない口の戻り値を射影型へ狭める
 * （設計 §6.5.1、受け入れ条件 #147・#148・#151・#152）。
 *
 * **塞いだのがルート 1 ファイルだけでは足りない。**
 * `getSystemSettings`（`permission: null`）と `loadSystemSettings()` が全項目を返したままだと、
 * 将来「未認証で読める公開設定」の口をもう 1 つ足す人が戻り値をそのまま返した瞬間、
 * 基準タイムゾーンがまた未認証へ出る。**1 ファイルを見る静的検査は新しいファイルを見ない。**
 *
 * 実行時の検査（`system-settings.integration.test.ts` の #147 / #148 / #153）と両輪。
 * **宣言そのもの**を固定しないと、たまたま値が入っていない状態でも通ってしまう。
 */
describe('未認証で読める設定の射影（#147 / #148 / #151 / #152）', () => {
  const useCases = withoutComments(
    read('application', 'system-settings', 'system-settings-use-cases.ts'),
  );
  const domain = withoutComments(read('domain', 'system-settings.ts'));

  /** 判断の置き場は Domain（ここへ項目を足すことが「未認証へ公開する」判断そのもの）。 */
  it('domain/system-settings.ts が PublicSystemSettings と toPublicSystemSettings を export する', () => {
    expect(domain).toContain('export interface PublicSystemSettings');
    expect(domain).toContain('export function toPublicSystemSettings');
  });

  /** #147。`permission: null` の UseCase の戻り値の型。 */
  it('getSystemSettings の戻り値の型が PublicSystemSettings', () => {
    expect(useCases).toContain('PublicSystemSettings>({');
    expect(useCases).not.toContain('never>, SystemSettings>');
  });

  /** #148。認可の文脈を持たない読み出しの戻り値の型。 */
  it('loadSystemSettings の戻り値の型が PublicSystemSettings', () => {
    expect(useCases).toContain('loadSystemSettings(): Promise<PublicSystemSettings>');
  });

  /**
   * #147 / #148。全項目版へ戻していない。
   *
   * `toSystemSettings` を呼べば `analyticsTimeZone` が戻り値に入り、射影の意味が消える。
   */
  it('認可の文脈を持たない 2 つの口が toPublicSystemSettings を使い、toSystemSettings を呼ばない', () => {
    expect(useCases).toContain('toPublicSystemSettings(');
    expect(useCases).not.toContain('toSystemSettings(');
  });

  /**
   * #152。`reason` は **1 行に収める**。
   *
   * `reason:` の行を正規表現で見る静的検査があるので、prettier が折り返す長さにすると落ちる。
   * 理由の全文は直上の JSDoc へ置く。
   */
  it('getSystemSettings の reason が 1 行で、射影である旨を述べている', () => {
    const line = useCases.split('\n').find((row) => row.trim().startsWith('reason:'));

    expect(line, 'reason: の行が見つからない').toBeDefined();
    // 同じ行で閉じている（次の行へ折り返していない）。
    expect((line ?? '').trim()).toMatch(/,$/);
    expect(line).toMatch(/射影|公開してよい/);
  });

  /** #152。事実と食い違っていた旧文言（「秘密の値を含まない」だけ）に戻っていない。 */
  it('reason が「秘密の値を含まない」だけで終わっていない', () => {
    const line = useCases.split('\n').find((row) => row.trim().startsWith('reason:')) ?? '';

    expect(line.includes('秘密の値を含まない') && !/射影|公開してよい/.test(line)).toBe(false);
  });
});

/**
 * #151。**`analyticsTimeZone` に触れる範囲そのものを固定する。**
 *
 * **危ないのは型ではなく関数のほう。** 射影（`toPublicSystemSettings`）を経由せずに
 * `toSystemSettings` を import して `systemSettingsRepository.loadAll()` の結果を直接畳めば、
 * `permission: null` の新しい口からでも基準タイムゾーンをそのまま返せてしまう。
 * 型の閉包はこれを止めない。だから**型と関数の両方**を見る。
 *
 * **一覧を等値で固定する。** `outside` が空であることだけを見る形だと、
 * 判定が 1 件も一致しなくなった瞬間に**空振りのまま緑になる**（実際そうなっていた）。
 * 許可した側が実際に一致していることを、同じ 1 つの assertion で確かめる。
 */
describe('SystemSettings（全項目）を import する範囲（#151）', () => {
  /**
   * そのファイルが**全項目**の名前（型 `SystemSettings` / 関数 `toSystemSettings`）を
   * Domain から取っているか。
   */
  function importsFullSettings(source: string): boolean {
    const pattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:@\/domain\/system-settings|\.\/system-settings|\.\.\/system-settings)['"]/g;
    for (const match of source.matchAll(pattern)) {
      const names = (match[1] ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/^type\s+/, ''));
      if (names.some((name) => name === 'SystemSettings' || name === 'toSystemSettings')) {
        return true;
      }
    }
    return false;
  }

  const importers = productionFiles()
    .filter((path) => importsFullSettings(withoutComments(readFileSync(path, 'utf8'))))
    .map((path) => relative(SRC_DIR, path).split(sep).join('/'))
    .sort();

  /**
   * 全項目に触れてよい製品ファイル。
   *
   * `domain/system-settings.ts` は**定義側**なので import では一致しない。
   * 設計 §6.5.1 は `domain/` も許しているが、いま一致するのはここだけなので、
   * **一覧そのものを固定する**。`domain/` の中から取る必要が出たら、
   * この一覧に足すことがその判断の記録になる。
   */
  const ALLOWED_FULL_SETTINGS_IMPORTERS = ['application/analytics/timezone.ts'];

  /**
   * **等値で固定する。** これ 1 つで 2 つのことが同時に決まる。
   *
   * * 許可した外から import していない（`outside` が空であること）
   * * **許可した側が実際に一致している**（判定が 1 件も拾わなくなれば、ここで落ちる）
   */
  it('全項目を import している製品ファイルは application/analytics/timezone.ts だけ', () => {
    expect(importers, `全項目を import している: ${importers.join(', ')}`).toEqual(
      ALLOWED_FULL_SETTINGS_IMPORTERS,
    );
  });

  /**
   * 判定が**関数名のほう**も拾うこと。
   *
   * 型 `SystemSettings` だけを見ていると、`toSystemSettings` を直接 import して
   * `loadAll()` の結果を畳む経路が素通りする（それが実際の抜け道だった）。
   */
  it('型 SystemSettings と関数 toSystemSettings の両方を拾う', () => {
    const typeOnly = "import type { SystemSettings } from '@/domain/system-settings';";
    const functionOnly =
      "import { SYSTEM_SETTING_KEYS, toSystemSettings } from '@/domain/system-settings';";

    expect(importsFullSettings(typeOnly)).toBe(true);
    expect(importsFullSettings(functionOnly)).toBe(true);
    // 合成した文字列だけで通っていないこと（実物でも拾えている）。
    expect(
      importsFullSettings(withoutComments(read('application', 'analytics', 'timezone.ts'))),
    ).toBe(true);
  });

  /** 空振りの逆側。射影だけを取るファイルは拾わない（判定が広すぎない）。 */
  it('toPublicSystemSettings だけを取るファイルは拾わない', () => {
    const projectionOnly = "import { toPublicSystemSettings } from '@/domain/system-settings';";

    expect(importsFullSettings(projectionOnly)).toBe(false);
  });

  /** 解決の経路は残っている（`analyticsTimeZone` を読むのはここだけ）。 */
  it('application/analytics/timezone.ts が SystemSettings 由来の解決を持ち続ける', () => {
    const timezone = withoutComments(read('application', 'analytics', 'timezone.ts'));

    expect(timezone).toContain('analyticsTimeZone');
  });
});

/**
 * #154。**振る舞いを変えていない。**
 *
 * 射影で狭めた 2 つの口の呼び出し元が、いずれも公開してよい 2 項目しか読んでいないこと。
 * どこかが `analyticsTimeZone` を読んでいれば、狭めた瞬間に画面が壊れる。
 */
describe('射影で狭めた口の呼び出し元（#154）', () => {
  const callers = [
    ['app/layout.tsx', ['app', 'layout.tsx']],
    ['ui/layout/app-shell.tsx', ['ui', 'layout', 'app-shell.tsx']],
    ['app/login/page.tsx', ['app', 'login', 'page.tsx']],
    ['application/auth/login.ts', ['application', 'auth', 'login.ts']],
    ['app/settings/page.tsx', ['app', 'settings', 'page.tsx']],
  ] as const;

  /**
   * 設定オブジェクトから読んでいる形だけを見る。
   *
   * `analyticsTimeZoneSetting()` を呼ぶのは別の経路（値と出所の両方が要る設定画面）で、
   * 射影で狭めた 2 つの口とは関係が無い。素の部分文字列で見ると、それを誤検知する。
   */
  const FIELD_READS = [
    '.analyticsTimeZone',
    'analyticsTimeZone,',
    'analyticsTimeZone }',
    'analyticsTimeZone}',
  ];

  it.each(callers.map(([label, segments]) => [label, [...segments]] as const))(
    '%s が設定オブジェクトから analyticsTimeZone を読まない',
    (_label, segments) => {
      const source = withoutComments(read(...segments));

      for (const forbidden of FIELD_READS) {
        expect(source, forbidden).not.toContain(forbidden);
      }
    },
  );

  /**
   * 判定が空振りしていない。**読んでいる形なら実際に捕まる**ことを合成した文字列で確かめる。
   *
   * これが無いと、書き方が変わって 1 つも一致しなくなっても、否定の検査だけが緑で残る。
   */
  it.each([
    ['プロパティ参照', 'const tz = settings.analyticsTimeZone;'],
    ['分割代入', 'const { analyticsTimeZone } = settings;'],
    ['オブジェクトの詰め直し', 'return { analyticsTimeZone, serviceName };'],
  ])('%s は捕まる', (_label, source) => {
    expect(FIELD_READS.some((forbidden) => source.includes(forbidden))).toBe(true);
  });

  /** 検査が空振りしていない（読んでいる 2 項目は残っている）。 */
  it('呼び出し元のどこかが serviceName と rememberMeEnabled を読んでいる', () => {
    const sources = callers.map(([, segments]) => withoutComments(read(...segments))).join('\n');

    expect(sources).toContain('serviceName');
    expect(sources).toContain('rememberMeEnabled');
  });
});
