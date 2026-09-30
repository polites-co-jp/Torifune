import { describe, expect, it } from 'vitest';
import { ownValue } from './own-value';

/**
 * 辞書の自分のプロパティだけを返す部品（047-prototype-key-sweep 設計 §4.1、受け入れ条件 #1）。
 *
 * 素のオブジェクトは `Object.prototype` を継承するので、`obj['constructor']` は
 * 辞書に無くても `Object` 関数を返す（設計 §1.1）。`ownValue` は継承したものを `undefined` にする。
 */

/** 設計 §10 の「原型の名前」。 */
const PROTOTYPE_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('#1 ownValue は辞書の自分のプロパティだけを返す', () => {
  it('#1 自分のキー a の値を返す', () => {
    expect(ownValue({ a: 1 }, 'a')).toBe(1);
  });

  it.each(PROTOTYPE_NAMES)('#1 自分のキーに無い原型の名前 %s は undefined', (name) => {
    expect(ownValue({ a: 1 }, name)).toBeUndefined();
  });

  it('#1 Object.fromEntries で自分のキーにした constructor は読める', () => {
    expect(ownValue(Object.fromEntries([['constructor', 2]]), 'constructor')).toBe(2);
  });

  it('#1 Object.fromEntries で自分のキーにした __proto__ は読める', () => {
    // JSON.parse を使わずに作る（実装プラン T1）。`Object.fromEntries` は `__proto__` も自分のキーにする。
    const dictionary: Record<string, number> = Object.fromEntries([['__proto__', 3]]);

    expect(Object.hasOwn(dictionary, '__proto__')).toBe(true);
    expect(ownValue(dictionary, '__proto__')).toBe(3);
  });

  it('#1 原型を持たない辞書（Object.create(null)）の自分のキーを返す', () => {
    const dictionary = Object.create(null) as Record<string, number>;
    dictionary['a'] = 4;

    expect(ownValue(dictionary, 'a')).toBe(4);
  });

  it('#1 辞書が undefined なら undefined', () => {
    expect(ownValue(undefined, 'a')).toBeUndefined();
  });
});
