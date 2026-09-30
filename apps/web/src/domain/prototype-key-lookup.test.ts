import { describe, expect, it } from 'vitest';
import { describePermission, PERMISSION_DESCRIPTIONS } from './permission';
import { providerLabel } from './social/social';

/**
 * 原型の名前（`constructor` など）で Domain の表を引いたときの結果
 * （047-prototype-key-sweep 設計 §4.2・§6、受け入れ条件 #2・#3 の前半）。
 *
 * 変更前は `providerLabel('constructor')` が `Object` 関数を返し、画面のアカウント名が
 * `とりふね（function Object() { [native code] }）` になっていた（設計 §1.2・K3）。
 * `describePermission('toString')` も関数を返し、権限の一覧の説明が空欄になっていた（K6）。
 */

const PROTOTYPE_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('#2 providerLabel は原型の名前をそのまま返す', () => {
  const cases: readonly (readonly [string, Readonly<Record<string, string>> | undefined])[] = [
    ['constructor', undefined],
    ['constructor', {}],
    ['constructor', { x: 'X' }],
    ['toString', { x: 'X' }],
  ];

  it.each(cases)('#2 providerLabel(%s, %o) は引数の provider そのもの', (provider, overrides) => {
    const label = providerLabel(provider, overrides);

    expect(typeof label).toBe('string');
    expect(label).toBe(provider);
  });

  it('#2 従来どおり：x は X', () => {
    expect(providerLabel('x')).toBe('X');
  });

  it('#2 従来どおり：登録された表示名を優先する', () => {
    expect(providerLabel('x', { x: 'X（登録）' })).toBe('X（登録）');
  });

  it('#2 従来どおり：知らない provider は生の値', () => {
    expect(providerLabel('unknown_sns')).toBe('unknown_sns');
  });

  it('#2 自分のキーとして登録された constructor の表示名は使われる', () => {
    expect(providerLabel('constructor', Object.fromEntries([['constructor', 'C']]))).toBe('C');
  });
});

describe('#3 describePermission は原型の名前に説明を返さない', () => {
  it.each(PROTOTYPE_NAMES)('#3 describePermission(%s) は null', (name) => {
    expect(describePermission(name)).toBeNull();
  });

  it('#3 従来どおり：site.read は従来の説明', () => {
    expect(describePermission('site.read')).toBe(PERMISSION_DESCRIPTIONS['site.read']);
    expect(describePermission('site.read')).toBe('Webサイトの一覧と詳細を見る');
  });
});
