import { describe, expect, it } from 'vitest';
import { BREAKDOWN_KEY_MAX_LENGTH, isValidBreakdownKey } from './analytics';

/**
 * 内訳キーの検証（028-analytics-dashboard-redesign 設計 §5.2、実装プラン T1）。
 *
 * `isValidBreakdownKey(value)`：長さ 500 以下、制御文字を含まない。**空文字は可**（キーを持たない指標）。
 */

describe('isValidBreakdownKey', () => {
  it('空文字を受け付ける（キーを持たない指標）', () => {
    expect(isValidBreakdownKey('')).toBe(true);
  });

  it('パスやホスト名を受け付ける', () => {
    expect(isValidBreakdownKey('/pricing')).toBe(true);
    expect(isValidBreakdownKey('www.example.com')).toBe(true);
    expect(isValidBreakdownKey('(direct)')).toBe(true);
    expect(isValidBreakdownKey('08')).toBe(true);
  });

  /** 500 は PATH_MAX_LENGTH と同じ。パスを key に入れるため。 */
  it('500 文字を受け付ける', () => {
    expect(isValidBreakdownKey('a'.repeat(500))).toBe(true);
  });

  it('501 文字を受け付けない', () => {
    expect(isValidBreakdownKey('a'.repeat(501))).toBe(false);
  });

  it.each([
    ['改行 (0x0a)', 10],
    ['復帰 (0x0d)', 13],
    ['タブ (0x09)', 9],
    ['NUL (0x00)', 0],
    ['単位区切り (0x1f)', 31],
    ['DEL (0x7f)', 127],
  ])('制御文字を含むと受け付けない: %s', (_label, code) => {
    expect(isValidBreakdownKey(`/a${String.fromCharCode(code)}b`)).toBe(false);
  });

  it('上限の定数は 500', () => {
    expect(BREAKDOWN_KEY_MAX_LENGTH).toBe(500);
  });
});
