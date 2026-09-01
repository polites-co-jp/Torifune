import { describe, expect, it } from 'vitest';
import { isCampaignStatus, isValidCampaignName, isValidDateOnly, isValidPeriod } from './campaign';

describe('isValidCampaignName', () => {
  it.each(['春の施策', 'a'.repeat(200)])('受け入れる: %s', (value) => {
    expect(isValidCampaignName(value)).toBe(true);
  });

  it.each(['', '   ', 'a'.repeat(201)])('拒否する: %s', (value) => {
    expect(isValidCampaignName(value)).toBe(false);
  });
});

describe('isCampaignStatus', () => {
  it.each(['draft', 'running', 'finished', 'cancelled'])('受け入れる: %s', (value) => {
    expect(isCampaignStatus(value)).toBe(true);
  });

  it('知らない状態を拒否する', () => {
    expect(isCampaignStatus('paused')).toBe(false);
  });
});

describe('isValidDateOnly', () => {
  it.each(['2026-01-01', '2026-12-31', '2024-02-29'])('受け入れる: %s', (value) => {
    expect(isValidDateOnly(value)).toBe(true);
  });

  /**
   * `new Date()` に任せると `2026-02-31` を3月へ丸めてしまい、
   * 利用者の入力と違う値が保存される。
   */
  it.each([
    '2026-02-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-32',
    '2025-02-29',
    '2026/01/01',
    '26-01-01',
    '2026-1-1',
    '',
    'today',
  ])('拒否する: %s', (value) => {
    expect(isValidDateOnly(value)).toBe(false);
  });
});

describe('isValidPeriod', () => {
  it('開始だけなら成立する', () => {
    expect(isValidPeriod('2026-04-01', null)).toBe(true);
  });

  it('終了が開始より後なら成立する', () => {
    expect(isValidPeriod('2026-04-01', '2026-04-30')).toBe(true);
  });

  /** 1日だけのキャンペーンは普通にある。 */
  it('同じ日なら成立する', () => {
    expect(isValidPeriod('2026-04-01', '2026-04-01')).toBe(true);
  });

  /** 逆転を許すと、一覧の並びも期間の計算も壊れる。 */
  it('終了が開始より前なら成立しない', () => {
    expect(isValidPeriod('2026-04-30', '2026-04-01')).toBe(false);
  });

  it('日付として壊れていれば成立しない', () => {
    expect(isValidPeriod('2026-02-31', null)).toBe(false);
    expect(isValidPeriod('2026-04-01', '2026-02-31')).toBe(false);
  });
});
