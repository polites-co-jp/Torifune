import { describe, expect, it } from 'vitest';
import { isValidExternalUrl, isValidLink, isValidManualUrl, isValidMediaUrl } from './social';

/**
 * 外部 URL の判定が NUL（U+0000）を含む値を断る（046-input-500-nul-and-ranges 設計 §4.1・§9.4、受け入れ条件 #6）。
 *
 * `new URL()` は NUL をパーセント符号化して通すので、判定を通った値がそのまま `text` 列へ書かれて
 * Postgres に断られていた（`publish()` の `externalUrl`・`manual()` の `url`）。
 * 4 つの判定（`isValidExternalUrl`・`isValidMediaUrl`・`isValidLink`・`isValidManualUrl` の絶対 URL）が
 * NUL を含む値を偽にし、NUL の無い同じ URL は従来どおり真にする。
 *
 * `isValidManualUrl` の `/` で始まる値（`isSafeReturnTo`）は、制御文字を既に断っている（対照）。
 */

const VALID = 'https://x.example.com/p';
const WITH_NUL = 'https://x.example.com/p\u0000';

const VALIDATORS = [
  { name: 'isValidExternalUrl', check: isValidExternalUrl },
  { name: 'isValidMediaUrl', check: isValidMediaUrl },
  { name: 'isValidLink', check: isValidLink },
  { name: 'isValidManualUrl', check: isValidManualUrl },
] as const;

describe('#6 外部 URL の判定が NUL を含む値を偽にする', () => {
  it.each(VALIDATORS)('#6 $name は末尾に NUL を含む https の URL を偽にする', ({ check }) => {
    expect(check(WITH_NUL)).toBe(false);
  });

  it.each(VALIDATORS)('#6 $name はパスの途中に NUL を含む URL を偽にする', ({ check }) => {
    expect(check('https://x.example.com/a\u0000b/c')).toBe(false);
  });

  it.each(VALIDATORS)('#6 $name はクエリに NUL を含む URL を偽にする', ({ check }) => {
    expect(check('https://x.example.com/intent?text=a\u0000')).toBe(false);
  });

  it.each(VALIDATORS)('#6 $name は NUL の無い同じ URL を真のままにする', ({ check }) => {
    expect(check(VALID)).toBe(true);
  });
});

describe('#6 対照：/ で始まる Torifune 内のパスは従来どおり', () => {
  it('#6 isValidManualUrl は NUL を含む / で始まるパスを偽にする（isSafeReturnTo が制御文字を断る）', () => {
    expect(isValidManualUrl('/social/manual\u0000')).toBe(false);
  });

  it('#6 isValidManualUrl は NUL の無い / で始まるパスを真にする', () => {
    expect(isValidManualUrl('/social/manual')).toBe(true);
  });
});
