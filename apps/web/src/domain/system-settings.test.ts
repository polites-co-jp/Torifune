import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_NAME,
  isValidServiceName,
  REMEMBER_ME_LIFETIME_MS,
  sessionLifetimeMs,
  SYSTEM_SETTING_KEYS,
  toSystemSettings,
} from './system-settings';
import * as systemSettingsModule from './system-settings';

const DEFAULT_LIFETIME = 7 * 24 * 60 * 60 * 1000;

describe('toSystemSettings', () => {
  it('保存された値を読む', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([
        [SYSTEM_SETTING_KEYS.serviceName, '検証環境'],
        [SYSTEM_SETTING_KEYS.rememberMeEnabled, false],
      ]),
    );

    expect(settings.serviceName).toBe('検証環境');
    expect(settings.rememberMeEnabled).toBe(false);
  });

  it('何も保存されていなければ既定を使う', () => {
    const settings = toSystemSettings(new Map());
    expect(settings.serviceName).toBe(DEFAULT_SERVICE_NAME);
    expect(settings.rememberMeEnabled).toBe(true);
  });

  /**
   * 設定の読み出しでアプリが起動しなくなるより、既定で動いたほうがよい。
   * 表示名が既定に戻れば、人が気づいて直せる。
   */
  it.each([
    ['数値', 123],
    ['null', null],
    ['空文字', ''],
    ['空白のみ', '   '],
    ['長すぎる', 'a'.repeat(51)],
  ])('壊れた表示名は既定へ落とす: %s', (_label, value) => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.serviceName, value]]),
    );
    expect(settings.serviceName).toBe(DEFAULT_SERVICE_NAME);
  });

  it('壊れた真偽値は既定へ落とす', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.rememberMeEnabled, 'yes']]),
    );
    expect(settings.rememberMeEnabled).toBe(true);
  });

  it('前後の空白を落とす', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.serviceName, '  検証  ']]),
    );
    expect(settings.serviceName).toBe('検証');
  });
});

/**
 * 基準タイムゾーン（032-timezone-setting 設計 §5.2、受け入れ条件 #12〜#15）。
 *
 * **既定は `'UTC'` ではなく `null`（未設定）。**
 * 既定を `'UTC'` にすると、`TORIFUNE_TIMEZONE=Asia/Tokyo` の既存環境が、
 * 画面で一度も触っていないのに UTC へ落ちる（裁定 §3.1 を型で守る）。
 *
 * 読み出しでは**一覧との照合をしない**（保存時は厳しく、読み出しは緩く。§5.3）。
 */
describe('toSystemSettings の analyticsTimeZone', () => {
  /** #12。未設定は `null`（＝環境変数へ落ちる）。 */
  it('保存されていなければ null', () => {
    expect(toSystemSettings(new Map()).analyticsTimeZone).toBeNull();
  });

  /** #13 */
  it('保存された IANA 名をそのまま返す', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.analyticsTimeZone, 'Asia/Tokyo']]),
    );

    expect(settings.analyticsTimeZone).toBe('Asia/Tokyo');
  });

  /** #14。異常系。壊れた値は既定（未設定）へ落とす。 */
  it('解釈できないタイムゾーン名は null', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.analyticsTimeZone, 'Foo/Bar']]),
    );

    expect(settings.analyticsTimeZone).toBeNull();
  });

  /** #15。異常系。型違い。 */
  it.each([
    ['数値', 42],
    ['null', null],
    ['真偽値', true],
    ['空文字', ''],
  ])('型が違う値は null: %s', (_label, value) => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.analyticsTimeZone, value]]),
    );

    expect(settings.analyticsTimeZone).toBeNull();
  });

  /**
   * 読み出しでは一覧（`isSelectableTimeZone`）と照合しない。
   *
   * 一覧に無いだけの値（`Etc/GMT+5`）を `null` へ落とすと、
   * 保存済みの環境の境目が黙って動く。判定は `isValidTimeZone` だけ（§5.2）。
   */
  it('一覧に無くても解釈できる名前はそのまま返す', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.analyticsTimeZone, 'Etc/GMT+5']]),
    );

    expect(settings.analyticsTimeZone).toBe('Etc/GMT+5');
  });

  /** キーは `analytics.time_zone`（`system_settings_key_format` の CHECK に適合する）。 */
  it('保存キーは analytics.time_zone', () => {
    expect(SYSTEM_SETTING_KEYS.analyticsTimeZone).toBe('analytics.time_zone');
  });
});

describe('sessionLifetimeMs', () => {
  it('Remember Me なら長期になる', () => {
    expect(sessionLifetimeMs(DEFAULT_LIFETIME, { rememberMe: true, rememberMeEnabled: true })).toBe(
      REMEMBER_ME_LIFETIME_MS,
    );
  });

  it('Remember Me を指定しなければ既定のまま', () => {
    expect(
      sessionLifetimeMs(DEFAULT_LIFETIME, { rememberMe: false, rememberMeEnabled: true }),
    ).toBe(DEFAULT_LIFETIME);
  });

  /** 組織の方針で禁止できる。チェックしても延びない。 */
  it('設定で禁止されていれば延びない', () => {
    expect(
      sessionLifetimeMs(DEFAULT_LIFETIME, { rememberMe: true, rememberMeEnabled: false }),
    ).toBe(DEFAULT_LIFETIME);
  });

  it('長期のほうが既定より長い', () => {
    expect(REMEMBER_ME_LIFETIME_MS).toBeGreaterThan(DEFAULT_LIFETIME);
  });
});

describe('isValidServiceName', () => {
  it.each(['とりふね', '検証環境', 'a'.repeat(50)])('受け入れる: %s', (value) => {
    expect(isValidServiceName(value)).toBe(true);
  });

  it.each(['', '   ', 'a'.repeat(51)])('拒否する: %s', (value) => {
    expect(isValidServiceName(value)).toBe(false);
  });
});

/**
 * 追加 F：`GET /api/v1/settings` から落とす（032 設計 §6.5.1、受け入れ条件 #146）。
 *
 * **落としたのは API の応答だけ。** Domain の `toSystemSettings` は
 * 従来どおり `analyticsTimeZone` を返す（キャッシュの解決に要る）。
 */
describe('API の応答から落としても Domain は変わらない（#146）', () => {
  it('toSystemSettings は analyticsTimeZone を返し続ける', () => {
    const settings = toSystemSettings(
      new Map<string, unknown>([
        [SYSTEM_SETTING_KEYS.serviceName, '検証環境'],
        [SYSTEM_SETTING_KEYS.analyticsTimeZone, 'Europe/Berlin'],
      ]),
    );

    expect(settings.analyticsTimeZone).toBe('Europe/Berlin');
    // 既存の 2 項目も従来どおり（#144 の Domain 側）。
    expect(settings.serviceName).toBe('検証環境');
    expect(settings.rememberMeEnabled).toBe(true);
  });
});

/**
 * 追加 G：未認証で読める設定の許可リストを Domain の型へ
 * （032 設計 §6.5.1、受け入れ条件 #149 / #150）。
 *
 * **射影を足しただけで、解決の経路は変えていない。**
 * `toSystemSettings`（全項目）はキャッシュの解決に要るので従来どおり、
 * 認可の文脈を持たない口が使う `toPublicSystemSettings` だけが 2 項目に狭まる。
 *
 * **名前空間で受ける。** まだ無い export を名前付き import すると、
 * このファイル全体が読み込みに失敗して他の検査まで評価されなくなる。
 */
const domain = systemSettingsModule as unknown as Record<string, unknown>;

describe('toPublicSystemSettings（#149）', () => {
  /** 「未認証へ公開する」という判断を 1 か所に閉じ込めるための型。 */
  function toPublic(stored: ReadonlyMap<string, unknown>): Record<string, unknown> {
    const fn = domain['toPublicSystemSettings'];
    expect(fn, 'toPublicSystemSettings が無い').toBeTypeOf('function');
    return (fn as (input: ReadonlyMap<string, unknown>) => Record<string, unknown>)(stored);
  }

  it('何も保存されていなければ既定の 2 項目を返す', () => {
    const settings = toPublic(new Map());

    expect(settings['serviceName']).toBe(DEFAULT_SERVICE_NAME);
    expect(settings['rememberMeEnabled']).toBe(true);
  });

  it('保存された 2 項目を読む', () => {
    const settings = toPublic(
      new Map<string, unknown>([
        [SYSTEM_SETTING_KEYS.serviceName, '検証環境'],
        [SYSTEM_SETTING_KEYS.rememberMeEnabled, false],
      ]),
    );

    expect(settings['serviceName']).toBe('検証環境');
    expect(settings['rememberMeEnabled']).toBe(false);
  });

  /** #149。**保存されていても無視する。** ここに載せないことが「公開しない」判断そのもの。 */
  it('保存された analytics.time_zone を無視し、キーごと持たない', () => {
    const settings = toPublic(
      new Map<string, unknown>([[SYSTEM_SETTING_KEYS.analyticsTimeZone, 'Asia/Tokyo']]),
    );

    expect(Object.keys(settings).sort()).toEqual(['rememberMeEnabled', 'serviceName']);
    expect(JSON.stringify(settings)).not.toContain('Asia/Tokyo');
  });

  /**
   * #150。**射影を足しただけ。** 全項目版は従来どおり基準タイムゾーンを返す（#146 と両立）。
   *
   * 同じ入力を 2 つの関数に通して、違いが `analyticsTimeZone` の有無だけであることを見る。
   */
  it('toSystemSettings は従来どおり analyticsTimeZone を返す', () => {
    const stored = new Map<string, unknown>([
      [SYSTEM_SETTING_KEYS.serviceName, '検証環境'],
      [SYSTEM_SETTING_KEYS.analyticsTimeZone, 'Asia/Tokyo'],
    ]);

    const full = toSystemSettings(stored);
    const publicOnly = toPublic(stored);

    expect(full.analyticsTimeZone).toBe('Asia/Tokyo');
    expect(publicOnly).not.toHaveProperty('analyticsTimeZone');
    // 公開する 2 項目の値は一致する（読み方を変えたのではなく、載せる範囲を狭めただけ）。
    expect(publicOnly['serviceName']).toBe(full.serviceName);
    expect(publicOnly['rememberMeEnabled']).toBe(full.rememberMeEnabled);
  });
});
