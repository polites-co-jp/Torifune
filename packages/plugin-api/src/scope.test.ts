import { describe, expect, it } from 'vitest';
import { pluginClassName, PluginScopeError, pluginScope } from './scope';

describe('pluginScope', () => {
  it('その Plugin の描画範囲を指すセレクタを返す', () => {
    expect(pluginScope('com.example.hello')).toBe('[data-torifune-plugin="com.example.hello"]');
  });

  it('ハイフンを含む ID も扱える', () => {
    expect(pluginScope('example-plugin')).toBe('[data-torifune-plugin="example-plugin"]');
  });

  /**
   * 属性値を素の文字列で埋めるため、セレクタを壊せる文字を弾く。
   * 通すと、Plugin ID の書き方ひとつで本体全体へ効くセレクタを作れてしまう。
   */
  it.each([
    'evil"] , * [x="',
    'has space',
    'UPPER',
    'quote"',
    'brack]et',
    '',
    '.leading',
    'trailing.',
  ])('セレクタを壊せる ID を拒否する: %s', (pluginId) => {
    expect(() => pluginScope(pluginId)).toThrow(PluginScopeError);
  });
});

describe('pluginClassName', () => {
  it('Plugin ごとに異なるクラス名を返す', () => {
    expect(pluginClassName('com.example.hello', 'card')).not.toBe(
      pluginClassName('com.example.other', 'card'),
    );
  });

  it('クラス名として使える形にする', () => {
    // ドットはクラスセレクタの区切りになるため残せない。
    expect(pluginClassName('com.example.hello', 'card')).toBe('tf-p-com-example-hello-card');
  });

  it('使えない ID を拒否する', () => {
    expect(() => pluginClassName('evil"]', 'card')).toThrow(PluginScopeError);
  });
});
