import { describe, expect, it } from 'vitest';
import { CAMPAIGN_LINK_MAX_ITEMS, normalizeCampaignLinkIds } from './campaign';

/**
 * キャンペーンの紐づけ先の ID（`siteIds` / `socialPostIds`）の規則
 * （045-campaign-input-500 設計 §4・§6.3、受け入れ条件 #6〜#9）。
 *
 * 1. 配列であること。要素は UUID の形（8-4-4-4-12 の 16 進。大文字・小文字を問わず、版と variant を見ない）
 * 2. 件数は 1000 件まで（重複を除く前の要素数）。**件数を形より先に見る**
 * 3. 形が正しければ小文字にそろえ、重複を除き、昇順に並べる
 *
 * 戻り値は `{ ok: true; ids } | { ok: false; reason: 'shape' | 'tooMany' }`。
 * 存在の確かめ（DB）はここでは行わない。
 */

const ID_A = '0192b7a0-5c1e-7a3b-8f10-2d7c4e8a1b23';
const ID_B = '0192b7a0-5c1e-7a3b-8f10-2d7c4e8a1b24';

/** 版 0・variant 0 の UUID の形（形だけを見るので通る）。 */
const VERSION_ZERO_UUID = '0192b7a0-5c1e-0a3b-0f10-2d7c4e8a1b23';

/* -------------------------------------------------------------------------- */
/* #6 成功する値                                                                  */
/* -------------------------------------------------------------------------- */

describe('#6 形の正しい ID は小文字・重複なし・昇順にそろえて通す', () => {
  it('#6 [] → 成功し、ids が []', () => {
    expect(normalizeCampaignLinkIds([])).toEqual({ ok: true, ids: [] });
  });

  it('#6 2 つの ID を逆順で渡す → 成功し、昇順に並ぶ', () => {
    expect(normalizeCampaignLinkIds([ID_B, ID_A])).toEqual({ ok: true, ids: [ID_A, ID_B] });
  });

  it('#6 同じ ID の小文字と大文字 → 成功し、小文字の 1 件になる', () => {
    expect(normalizeCampaignLinkIds([ID_A, ID_A.toUpperCase()])).toEqual({
      ok: true,
      ids: [ID_A],
    });
  });

  it('#6 大文字だけ → 成功し、小文字になる', () => {
    expect(normalizeCampaignLinkIds([ID_A.toUpperCase()])).toEqual({ ok: true, ids: [ID_A] });
  });

  it('#6 同じ ID の重複 → 成功し、1 件になる', () => {
    expect(normalizeCampaignLinkIds([ID_A, ID_A])).toEqual({ ok: true, ids: [ID_A] });
  });

  it('#6 00000000-0000-0000-0000-000000000000 → 成功（形だけを見る）', () => {
    const nil = '00000000-0000-0000-0000-000000000000';

    expect(normalizeCampaignLinkIds([nil])).toEqual({ ok: true, ids: [nil] });
  });

  it('#6 版 0・variant 0 の値 → 成功（版と variant を見ない）', () => {
    expect(normalizeCampaignLinkIds([VERSION_ZERO_UUID])).toEqual({
      ok: true,
      ids: [VERSION_ZERO_UUID],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #7 形の誤り                                                                    */
/* -------------------------------------------------------------------------- */

describe('#7 要素が UUID の形でなければ理由が「形」で失敗する', () => {
  it.each([
    ['abc', 'abc'],
    ['空文字', ''],
    ['ハイフンなしの 32 文字', ID_A.replaceAll('-', '')],
    ['{…} で囲んだ値', `{${ID_A}}`],
    ['NUL 文字', '\u0000'],
    ['37 文字', `${ID_A}0`],
    ['数値 123', 123],
    ['null', null],
  ] as const)('#7 要素が %s → { ok: false, reason: "shape" }', (_label, element) => {
    expect(normalizeCampaignLinkIds([element])).toEqual({ ok: false, reason: 'shape' });
  });

  it('#7 形の正しい ID に 1 つだけ形の誤りが混ざる → { ok: false, reason: "shape" }', () => {
    expect(normalizeCampaignLinkIds([ID_A, 'abc', ID_B])).toEqual({ ok: false, reason: 'shape' });
  });
});

describe('#7 配列でなければ理由が「形」で失敗する', () => {
  it.each([
    ['文字列 abc', 'abc'],
    ['空のオブジェクト', {}],
    ['null', null],
  ] as const)('#7 %s → { ok: false, reason: "shape" }', (_label, value) => {
    expect(normalizeCampaignLinkIds(value)).toEqual({ ok: false, reason: 'shape' });
  });

  it('#7 UUID の形の文字列 1 つ（配列でない）→ { ok: false, reason: "shape" }', () => {
    expect(normalizeCampaignLinkIds(ID_A)).toEqual({ ok: false, reason: 'shape' });
  });
});

/* -------------------------------------------------------------------------- */
/* #8 件数                                                                        */
/* -------------------------------------------------------------------------- */

describe('#8 件数は重複を除く前の要素数で 1000 件まで', () => {
  it('#8 同じ ID を 1000 個 → 成功し、1 件になる', () => {
    expect(normalizeCampaignLinkIds(Array.from({ length: 1000 }, () => ID_A))).toEqual({
      ok: true,
      ids: [ID_A],
    });
  });

  it('#8 同じ ID を 1001 個 → { ok: false, reason: "tooMany" }', () => {
    expect(normalizeCampaignLinkIds(Array.from({ length: 1001 }, () => ID_A))).toEqual({
      ok: false,
      reason: 'tooMany',
    });
  });

  it('#8 1001 個で 1 つが形の誤り → 理由は「件数」（件数を形より先に見る）', () => {
    const values: unknown[] = Array.from({ length: 1000 }, () => ID_A);
    values.push('abc');

    expect(normalizeCampaignLinkIds(values)).toEqual({ ok: false, reason: 'tooMany' });
  });

  it('#8 1000 個で 1 つが形の誤り → 理由は「形」（上限の内側では形を見る）', () => {
    const values: unknown[] = Array.from({ length: 999 }, () => ID_A);
    values.push('abc');

    expect(normalizeCampaignLinkIds(values)).toEqual({ ok: false, reason: 'shape' });
  });
});

/* -------------------------------------------------------------------------- */
/* #9 上限の定数                                                                   */
/* -------------------------------------------------------------------------- */

describe('#9 上限の定数', () => {
  it('#9 CAMPAIGN_LINK_MAX_ITEMS === 1000', () => {
    expect(CAMPAIGN_LINK_MAX_ITEMS).toBe(1000);
  });
});
