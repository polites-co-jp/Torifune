import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_NAME,
  isValidServiceName,
  REMEMBER_ME_LIFETIME_MS,
  sessionLifetimeMs,
  SYSTEM_SETTING_KEYS,
  toSystemSettings,
} from './system-settings';

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
