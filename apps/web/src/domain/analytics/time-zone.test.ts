import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalTimeZone,
  isSelectableTimeZone,
  listTimeZones,
  timeZoneOptions,
  type TimeZoneGroup,
} from './time-zone';

/**
 * タイムゾーン名そのものの扱い（032-timezone-setting 設計 §5.3、受け入れ条件 #1〜#11）。
 *
 * `day.ts` は「境目の計算」、ここは「**名前の扱い**」。純関数だけで、`Intl` 以外に依存しない。
 *
 * * 別名（`utc` / `Japan` / `US/Pacific`）は**正規化してから**保存する（§5.3.1）
 * * オフセット表記（`+09:00`）と `Etc/*` は**選べない**（一覧に無い。どの地域の 1 日か説明できない）
 * * 一覧に無い保存済みの値でも、選択欄から消えない（`extra` で必ず混ぜる。§5.3.2）
 */

/** 群をまたいだ全項目の `value`。 */
function valuesOf(groups: readonly TimeZoneGroup[]): string[] {
  return groups.flatMap((group) => group.options.map((option) => option.value));
}

/** ある値を持つ項目（無ければ undefined）。 */
function optionOf(groups: readonly TimeZoneGroup[], value: string) {
  return groups.flatMap((group) => group.options).find((option) => option.value === value);
}

const NOW = new Date('2026-09-06T12:00:00Z');

describe('canonicalTimeZone', () => {
  /** #1 */
  it('IANA の地域名はそのまま返す', () => {
    expect(canonicalTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  /** #2。大文字小文字の別名を正規化する。 */
  it('utc を UTC に正規化する', () => {
    expect(canonicalTimeZone('utc')).toBe('UTC');
  });

  /** #3。別名をそのまま保存すると、画面の一覧に一致する項目が無くなる（§5.3.1）。 */
  it('Japan を Asia/Tokyo に正規化する', () => {
    expect(canonicalTimeZone('Japan')).toBe('Asia/Tokyo');
  });

  /** #3 */
  it('US/Pacific を America/Los_Angeles に正規化する', () => {
    expect(canonicalTimeZone('US/Pacific')).toBe('America/Los_Angeles');
  });

  /** #4。異常系。**入力を trim しない**（`'UTC '` は解釈できない値として扱う）。 */
  it.each([
    ['解釈できない名前', 'Foo/Bar'],
    ['空文字', ''],
    ['末尾に空白', 'UTC '],
  ])('%s は null（%s）', (_label, value) => {
    expect(canonicalTimeZone(value)).toBeNull();
  });
});

describe('listTimeZones', () => {
  /** #5 */
  it('先頭が UTC で、Asia/Tokyo を含み、重複が無い', () => {
    const list = listTimeZones();

    expect(list[0]).toBe('UTC');
    expect(list).toContain('Asia/Tokyo');
    expect(new Set(list).size).toBe(list.length);
  });

  /** #5 の裏取り。検査が空振りしていない（`Intl.supportedValuesOf` の 400 件超が入っている）。 */
  it('UTC 以外の地域名も含む', () => {
    expect(listTimeZones().length).toBeGreaterThan(1);
  });
});

describe('isSelectableTimeZone', () => {
  /** #6。境界。固定オフセットは一覧に無く、「どの地域の 1 日か」を画面で説明できない。 */
  it('オフセット表記（+09:00）は選べない', () => {
    expect(isSelectableTimeZone('+09:00')).toBe(false);
  });

  /** #6 の対。`isValidTimeZone` は通してしまう値であることの確認（§5.3.1 の実測）。 */
  it('オフセット表記（-0800）も選べない', () => {
    expect(isSelectableTimeZone('-0800')).toBe(false);
  });

  /** #7。境界。 */
  it('Etc/GMT+5 は選べない（一覧に無い）', () => {
    expect(isSelectableTimeZone('Etc/GMT+5')).toBe(false);
  });

  /** #8。正規化してから照合する。 */
  it('utc は選べる', () => {
    expect(isSelectableTimeZone('utc')).toBe(true);
  });

  /** #8 の対。 */
  it.each(['UTC', 'Asia/Tokyo', 'Japan'])('選べる: %s', (value) => {
    expect(isSelectableTimeZone(value)).toBe(true);
  });

  /** 異常系。 */
  it.each(['Foo/Bar', '', 'UTC '])('選べない: %s', (value) => {
    expect(isSelectableTimeZone(value)).toBe(false);
  });
});

describe('timeZoneOptions', () => {
  /** #9 */
  it('地域ごとの群を返し、先頭の群は UTC だけを持つ', () => {
    const groups = timeZoneOptions(NOW, ['Asia/Tokyo']);

    expect(groups.length).toBeGreaterThan(1);
    expect(groups[0]?.options.map((option) => option.value)).toEqual(['UTC']);
    expect(groups.some((group) => group.region === 'Asia')).toBe(true);
  });

  /** #9。オフセットを添えると、名前を知らなくても目的の地域に辿り着ける（§7.1）。 */
  it('項目のラベルに現在のオフセットが添えられる', () => {
    const option = optionOf(timeZoneOptions(NOW, ['Asia/Tokyo']), 'Asia/Tokyo');

    expect(option?.label).toBe('Asia/Tokyo (GMT+09:00)');
  });

  /** #10。境界。`extra` が一覧と重複しても二重にならない。 */
  it('extra が一覧と重複しても項目は 1 度だけ', () => {
    const values = valuesOf(timeZoneOptions(NOW, ['Pacific/Chatham']));

    expect(values.filter((value) => value === 'Pacific/Chatham')).toHaveLength(1);
  });

  /** #10 の裏取り。UTC も二重にならない。 */
  it('extra に UTC を渡しても UTC は 1 度だけ', () => {
    const values = valuesOf(timeZoneOptions(NOW, ['UTC']));

    expect(values.filter((value) => value === 'UTC')).toHaveLength(1);
  });

  /**
   * #11。異常系。
   *
   * 一覧に無い保存済みの値が選択欄から消えると、選択欄が空で表示される（§5.3.2）。
   */
  it('一覧に無い保存済みの値でも選択肢に残る', () => {
    expect(valuesOf(timeZoneOptions(NOW, ['Made/Up']))).toContain('Made/Up');
  });

  /** #11。ラベルが取れない値でも、名前だけで項目になる（オフセットの取得で落ちない）。 */
  it('一覧に無い値のラベルは少なくとも名前を含む', () => {
    const option = optionOf(timeZoneOptions(NOW, ['Made/Up']), 'Made/Up');

    expect(option?.label).toContain('Made/Up');
  });

  /** 群の中身が空にならない（`<optgroup>` が空で描かれない）。 */
  it('どの群も 1 つ以上の項目を持つ', () => {
    for (const group of timeZoneOptions(NOW, ['Asia/Tokyo'])) {
      expect(group.options.length, group.region).toBeGreaterThanOrEqual(1);
    }
  });
});

/**
 * #11 の裏。`Intl.supportedValuesOf` が無い実行環境（ICU を削ったビルド）。
 *
 * 一覧が `['UTC']` だけになっても、保存済みの値は `extra` で混ざるので選択欄が壊れない。
 * `listTimeZones()` はモジュール内で 1 度だけ作るので、モジュールごと読み直して確かめる。
 */
describe('Intl.supportedValuesOf が無い実行環境', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('一覧は UTC だけになり、保存済みの値は extra で残る', async () => {
    // `Intl` の各プロパティは非列挙なので、スプレッドではなく記述子ごと写す。
    const stub: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(Intl)) {
      if (key === 'supportedValuesOf') {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(Intl, key);
      if (descriptor !== undefined) {
        Object.defineProperty(stub, key, descriptor);
      }
    }
    vi.stubGlobal('Intl', stub);
    vi.resetModules();

    const timeZone = await import('./time-zone');

    expect(timeZone.listTimeZones()).toEqual(['UTC']);
    expect(
      timeZone
        .timeZoneOptions(NOW, ['Asia/Tokyo'])
        .flatMap((group) => group.options.map((option) => option.value)),
    ).toContain('Asia/Tokyo');
  });
});
