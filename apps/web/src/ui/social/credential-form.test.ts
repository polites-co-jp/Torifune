import { describe, expect, it } from 'vitest';
import {
  clearCredentialBody,
  createCredentialBody,
  credentialInputOf,
  setCredentialBody,
} from './credential-form';
import type { ProviderCredentialField, ProviderOption } from './social-accounts';

/**
 * 資格情報の入力の形と、画面が送る本文（039-social-credential-fields 設計 §7.1 / §7.2 / §7.7、
 * 受け入れ条件 #1〜#4、#9〜#15）。
 *
 * **判定と本文の組み立てを純関数で固定する**（設計 §4）。単体テストの環境には DOM が無く、
 * Modal のボタンを押して送信の中身を見られないため。
 *
 * * 入力の形は 3 つ：`fields`（publisher あり・項目あり）/ `none`（publisher あり・`[]`）/
 *   `free`（publisher なし）。`publisherRegistered` の省略は `false` と読む（後方互換）
 * * 入れ直しは**丸ごと置き換え**。`fields` は宣言のキーちょうどで、全項目が要る
 * * 空とみなすのは長さ 0 だけ（正はサーバ。設計 §7.3.3 の 1）
 */

const FIELDS: readonly ProviderCredentialField[] = [
  { key: 'handle', label: 'ハンドル', kind: 'text' },
  { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
];

const ALL_FIELDS_REQUIRED = 'すべての項目を入力してください。';
const CREDENTIAL_REQUIRED = '資格情報を入力してください。';

function option(overrides: Partial<ProviderOption> = {}): ProviderOption {
  return { value: 'example', label: 'サンプルSNS', credentialFields: FIELDS, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* §10.1 入力の形                                                                */
/* -------------------------------------------------------------------------- */

describe('credentialInputOf', () => {
  it("#1 option が無い（一覧に無い provider）なら 'free'", () => {
    expect(credentialInputOf(undefined)).toBe('free');
  });

  it("#2 項目が 1 件以上で publisherRegistered: true なら 'fields'", () => {
    expect(credentialInputOf(option({ publisherRegistered: true }))).toBe('fields');
  });

  it("#2 項目が 1 件以上で publisherRegistered を省略しても 'fields'", () => {
    expect(credentialInputOf(option())).toBe('fields');
  });

  it("#2 項目が 1 件以上なら publisherRegistered: false でも 'fields'（表の上から順に判定する）", () => {
    expect(credentialInputOf(option({ publisherRegistered: false }))).toBe('fields');
  });

  it("#3 項目が [] で publisherRegistered: true なら 'none'", () => {
    expect(credentialInputOf(option({ credentialFields: [], publisherRegistered: true }))).toBe(
      'none',
    );
  });

  it("#4 項目が [] で publisherRegistered: false なら 'free'", () => {
    expect(credentialInputOf(option({ credentialFields: [], publisherRegistered: false }))).toBe(
      'free',
    );
  });

  it("#4 項目が [] で publisherRegistered を省略した場合も 'free'（後方互換）", () => {
    // 既存の単体テストのデータ（`{ value: 'x', credentialFields: [] }`）の意味を変えない。
    expect(credentialInputOf({ value: 'x', label: 'X', credentialFields: [] })).toBe('free');
  });
});

/* -------------------------------------------------------------------------- */
/* §10.3 アカウント追加の本文                                                     */
/* -------------------------------------------------------------------------- */

describe('createCredentialBody', () => {
  it("#9 none は { status: 'connected' } ちょうど", () => {
    expect(createCredentialBody('none', [], {}, '')).toStrictEqual({ status: 'connected' });
  });

  it('#9 none の本文には credential / credentials のキーが無い', () => {
    const body = createCredentialBody('none', [], {}, '');

    expect(Object.keys(body)).toEqual(['status']);
  });

  it("#9 none は credential に値が残っていても（'stale'）同じ", () => {
    // 「サービス」を free の provider から切り替えた後、前の入力が送られてはならない（設計 §7.2）。
    expect(createCredentialBody('none', [], {}, 'stale')).toStrictEqual({ status: 'connected' });
  });

  it('#9 none は項目の入力値が残っていても送らない', () => {
    // fields の provider から切り替えた後も同じ（設計 §7.2）。
    expect(
      createCredentialBody('none', [], { handle: 'stale', appPassword: 'stale' }, 'stale'),
    ).toStrictEqual({ status: 'connected' });
  });

  it("#10 fields で全項目を入れたら credentials と 'connected'", () => {
    expect(
      createCredentialBody('fields', FIELDS, { handle: 'h', appPassword: 'p' }, ''),
    ).toStrictEqual({ credentials: { handle: 'h', appPassword: 'p' }, status: 'connected' });
  });

  it("#10 fields で 1 つだけ入れたら、入れた項目だけの credentials と 'connected'", () => {
    expect(
      createCredentialBody('fields', FIELDS, { handle: 'h', appPassword: '' }, ''),
    ).toStrictEqual({ credentials: { handle: 'h' }, status: 'connected' });
  });

  it("#10 fields で 1 つも入れなければ credentials: {} と 'disconnected'", () => {
    // 現行の送り方（`credentials` のキーごと送る）を保つ（実装プラン §8 の 4）。
    expect(createCredentialBody('fields', FIELDS, {}, '')).toStrictEqual({
      credentials: {},
      status: 'disconnected',
    });
  });

  it('#10 fields の credentials に宣言に無いキーを入れない', () => {
    expect(
      createCredentialBody('fields', FIELDS, { handle: 'h', appPassword: 'p', extra: 'x' }, ''),
    ).toStrictEqual({ credentials: { handle: 'h', appPassword: 'p' }, status: 'connected' });
  });

  it('#10 fields は credential（自由文字列）を送らない', () => {
    const body = createCredentialBody('fields', FIELDS, { handle: 'h' }, 'stale');

    expect(Object.keys(body).sort()).toEqual(['credentials', 'status']);
  });

  it("#10 free で入れたら credential と 'connected'", () => {
    expect(createCredentialBody('free', [], {}, 'abc')).toStrictEqual({
      credential: 'abc',
      status: 'connected',
    });
  });

  it("#10 free で空なら credential: '' と 'disconnected'", () => {
    // 現行の送り方（`credential` のキーごと送る）を保つ（実装プラン §8 の 4）。
    expect(createCredentialBody('free', [], {}, '')).toStrictEqual({
      credential: '',
      status: 'disconnected',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* §10.3 入れ直しの本文                                                           */
/* -------------------------------------------------------------------------- */

describe('setCredentialBody', () => {
  it("#11 fields で 2 項目とも入れたら ok: true、宣言のキーちょうどの credentials と 'connected'", () => {
    expect(
      setCredentialBody('fields', FIELDS, { handle: 'h', appPassword: 'p' }, ''),
    ).toStrictEqual({
      ok: true,
      body: { credentials: { handle: 'h', appPassword: 'p' }, status: 'connected' },
    });
  });

  it('#11 values に宣言に無いキーが混ざっていても credentials に入らない', () => {
    expect(
      setCredentialBody('fields', FIELDS, { handle: 'h', appPassword: 'p', stale: 'old' }, ''),
    ).toStrictEqual({
      ok: true,
      body: { credentials: { handle: 'h', appPassword: 'p' }, status: 'connected' },
    });
  });

  it('#11 fields の本文は credential（自由文字列）を持たない', () => {
    const result = setCredentialBody('fields', FIELDS, { handle: 'h', appPassword: 'p' }, 'stale');

    expect(result.ok).toBe(true);
    expect(result.ok ? Object.keys(result.body).sort() : []).toEqual(['credentials', 'status']);
  });

  it('#11 空白だけの値は空とみなさず送る（空は長さ 0 だけ。正はサーバ）', () => {
    expect(
      setCredentialBody('fields', FIELDS, { handle: ' ', appPassword: 'p' }, ''),
    ).toStrictEqual({
      ok: true,
      body: { credentials: { handle: ' ', appPassword: 'p' }, status: 'connected' },
    });
  });

  it('#12 fields で 1 項目が空文字なら ok: false「すべての項目を入力してください。」', () => {
    expect(setCredentialBody('fields', FIELDS, { handle: 'h', appPassword: '' }, '')).toStrictEqual(
      { ok: false, message: ALL_FIELDS_REQUIRED },
    );
  });

  it('#12 fields で 1 項目が values に無いときも ok: false「すべての項目を入力してください。」', () => {
    expect(setCredentialBody('fields', FIELDS, { appPassword: 'p' }, '')).toStrictEqual({
      ok: false,
      message: ALL_FIELDS_REQUIRED,
    });
  });

  it('#12 fields で全部空でも ok: false「すべての項目を入力してください。」', () => {
    expect(setCredentialBody('fields', FIELDS, {}, '')).toStrictEqual({
      ok: false,
      message: ALL_FIELDS_REQUIRED,
    });
  });

  it('#12 fields で宣言に無いキーだけが入っていても ok: false', () => {
    expect(setCredentialBody('fields', FIELDS, { stale: 'old' }, 'abc')).toStrictEqual({
      ok: false,
      message: ALL_FIELDS_REQUIRED,
    });
  });

  it("#13 free で入れたら ok: true、body が { credential: 'abc', status: 'connected' } ちょうど", () => {
    expect(setCredentialBody('free', [], {}, 'abc')).toStrictEqual({
      ok: true,
      body: { credential: 'abc', status: 'connected' },
    });
  });

  it('#13 free で空文字なら ok: false「資格情報を入力してください。」', () => {
    expect(setCredentialBody('free', [], {}, '')).toStrictEqual({
      ok: false,
      message: CREDENTIAL_REQUIRED,
    });
  });

  it('#14 none は入力が無ければ ok: false', () => {
    expect(setCredentialBody('none', [], {}, '').ok).toBe(false);
  });

  it('#14 none は credential に値が残っていても ok: false', () => {
    expect(setCredentialBody('none', [], {}, 'stale').ok).toBe(false);
  });

  it('#14 none は項目の値が渡されても ok: false', () => {
    expect(setCredentialBody('none', FIELDS, { handle: 'h', appPassword: 'p' }, 'x').ok).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* §10.3 消去の本文                                                              */
/* -------------------------------------------------------------------------- */

describe('clearCredentialBody', () => {
  it("#15 fields は { credentials: {}, status: 'disconnected' }", () => {
    expect(clearCredentialBody('fields')).toStrictEqual({
      credentials: {},
      status: 'disconnected',
    });
  });

  it("#15 free は { credentials: {}, status: 'disconnected' }", () => {
    expect(clearCredentialBody('free')).toStrictEqual({ credentials: {}, status: 'disconnected' });
  });

  it('#15 none は { credentials: {} } ちょうど（status を送らない）', () => {
    // その provider では資格情報の有無が配信の支度に関わらない（設計 §7.4）。
    expect(clearCredentialBody('none')).toStrictEqual({ credentials: {} });
  });

  it('#15 none の本文には status のキーが無い', () => {
    expect(Object.keys(clearCredentialBody('none'))).toEqual(['credentials']);
  });
});
