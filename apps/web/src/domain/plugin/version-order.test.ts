import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from './version-order';

describe('compareVersions', () => {
  it.each([
    ['1.0.1', '1.0.0'],
    ['1.1.0', '1.0.9'],
    ['2.0.0', '1.99.99'],
    ['1.0.10', '1.0.9'],
  ])('%s は %s より新しい', (a, b) => {
    expect(compareVersions(a, b)).toBe(1);
    expect(compareVersions(b, a)).toBe(-1);
  });

  it.each([
    ['1.0.0', '1.0.0'],
    // 桁数が違っても、足りない側を 0 として比べる。
    ['1.2', '1.2.0'],
    ['1', '1.0.0'],
  ])('%s と %s は同じ', (a, b) => {
    expect(compareVersions(a, b)).toBe(0);
  });

  /** 数値として比べる。文字列比較だと 1.0.10 < 1.0.9 になる。 */
  it('桁数の多い数を文字列として比べない', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
  });

  it('数字でない部分は 0 として扱う', () => {
    expect(compareVersions('1.0.x', '1.0.0')).toBe(0);
  });

  it('前後の空白を無視する', () => {
    expect(compareVersions(' 1.0.0 ', '1.0.0')).toBe(0);
  });
});

describe('isNewerVersion', () => {
  it('上がっていれば true', () => {
    expect(isNewerVersion('1.1.0', '1.0.0')).toBe(true);
  });

  /** 版を下げる更新は許さない（設計 §2.4）。 */
  it('下がっていれば false', () => {
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(false);
  });

  it('同じなら false', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });
});
