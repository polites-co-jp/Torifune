import { describe, expect, it } from 'vitest';
import { resolveHelpLink, type HelpLinkContext } from './help-links';

/**
 * 手順書の中のリンクの解決（041-plugin-help-docs 設計 §7.3.4、受け入れ条件 #16〜#21）。
 *
 * 結果は 3 つ：`external`（新しいタブ）／`internal`（Torifune の中・同じタブ）／`none`（リンクにしない）。
 * **危ないスキーム・プロトコル相対・宣言していないファイルはリンクにしない。**
 * `context` は設計 §10.3 のものをそのまま使う。
 */

const context: HelpLinkContext = {
  pluginId: 'p',
  currentPath: 'help/credentials.md',
  docs: [
    { id: 'credentials', path: 'help/credentials.md' },
    { id: 'switching', path: 'help/switching.md' },
  ],
};

describe('#16 外部のリンク', () => {
  it.each([
    ['https://docs.x.com/a', 'https://docs.x.com/a'],
    ['HTTP://example.com', 'http://example.com/'],
    ['http://example.com/path?q=1#frag', 'http://example.com/path?q=1#frag'],
    ['  https://docs.x.com/a  ', 'https://docs.x.com/a'],
  ])('#16 %s → external（href は URL#href の %s）', (href, expected) => {
    expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'external', href: expected });
  });

  it('#16 href は new URL(…).href と同じ（大文字のスキームは正規化される）', () => {
    const href = 'HTTP://example.com';

    expect(resolveHelpLink(href, context)).toStrictEqual({
      kind: 'external',
      href: new URL(href).href,
    });
  });
});

describe('#17 危ないスキーム・http(s) 以外は none', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'file:///etc/passwd',
    'mailto:a@example.com',
    'ftp://x',
  ])('#17 %j → none', (href) => {
    expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'none' });
  });

  it.each([
    ['NUL を含む', `java${String.fromCharCode(0)}script:alert(1)`],
    ['改行を含む', 'https://example.com/\nx'],
    ['U+007F を含む', `https://example.com/${String.fromCharCode(0x7f)}`],
    ['U+001F を含む', `./switching.md${String.fromCharCode(0x1f)}`],
  ])('#17 制御文字（%s）を含むものは none', (_label, href) => {
    expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'none' });
  });

  it('#17 ホストの無い http(s) の URL は external にしない', () => {
    expect(resolveHelpLink('https://', context)).toStrictEqual({ kind: 'none' });
  });
});

describe('#18 プロトコル相対と Torifune の中の絶対パス', () => {
  it.each(['//evil.example/x', '/\\evil.example'])('#18 %j → none', (href) => {
    expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'none' });
  });

  it("#18 '/social' → internal（そのまま）", () => {
    expect(resolveHelpLink('/social', context)).toStrictEqual({
      kind: 'internal',
      href: '/social',
    });
  });
});

describe('#19 本文の中の断片', () => {
  it("#19 '#手順-1' → internal（'#help-手順-1'）", () => {
    expect(resolveHelpLink('#手順-1', context)).toStrictEqual({
      kind: 'internal',
      href: '#help-手順-1',
    });
  });

  it('#19 百分率符号化された断片は戻してから help- を足す', () => {
    expect(resolveHelpLink(`#${encodeURIComponent('手順-1')}`, context)).toStrictEqual({
      kind: 'internal',
      href: '#help-手順-1',
    });
  });
});

describe('#20 宣言した .md への相対パス', () => {
  it.each(['./switching.md', 'switching.md', '../help/switching.md'])(
    "#20 %j → internal（'/plugins/p/help/switching'）",
    (href) => {
      expect(resolveHelpLink(href, context)).toStrictEqual({
        kind: 'internal',
        href: '/plugins/p/help/switching',
      });
    },
  );

  it("#20 './switching.md#a' → '/plugins/p/help/switching#help-a'", () => {
    expect(resolveHelpLink('./switching.md#a', context)).toStrictEqual({
      kind: 'internal',
      href: '/plugins/p/help/switching#help-a',
    });
  });

  it("#20 'credentials.md'（いま描いている手順書そのもの）→ '/plugins/p/help/credentials'", () => {
    expect(resolveHelpLink('credentials.md', context)).toStrictEqual({
      kind: 'internal',
      href: '/plugins/p/help/credentials',
    });
  });

  it('#20 currentPath のフォルダを基準にする（フォルダの無い手順書からは help/ を付けて書く）', () => {
    const rootContext: HelpLinkContext = {
      pluginId: 'p',
      currentPath: 'guide.md',
      docs: [
        { id: 'guide', path: 'guide.md' },
        { id: 'switching', path: 'help/switching.md' },
      ],
    };

    expect(resolveHelpLink('help/switching.md', rootContext)).toStrictEqual({
      kind: 'internal',
      href: '/plugins/p/help/switching',
    });
    expect(resolveHelpLink('switching.md', rootContext)).toStrictEqual({ kind: 'none' });
  });
});

describe('#21 宣言していないもの・外へ出るものは none', () => {
  it.each(['../README.md', '../../x.md', './other.md', './a.png'])('#21 %j → none', (href) => {
    expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'none' });
  });

  it.each(['../plugin.json', '../index.ts', 'plugin.json', '../help/../plugin.json'])(
    '#21 Plugin の他のファイル %j → none',
    (href) => {
      expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'none' });
    },
  );
});

describe('#95 D2：Plugin のフォルダより上へ出る .. は丸めずに none', () => {
  it.each([
    '../../help/switching.md',
    '../../../help/switching.md',
    '../x/../../help/switching.md',
  ])('#95 %j（上へ出た後に宣言のパスへ戻る）→ none', (href) => {
    expect(resolveHelpLink(href, context)).toStrictEqual({ kind: 'none' });
  });

  it('#95 断片つきでも同じ（../../help/switching.md#a → none）', () => {
    expect(resolveHelpLink('../../help/switching.md#a', context)).toStrictEqual({ kind: 'none' });
  });

  it("#95 対の条件：上へ出ずに戻るだけの '../help/switching.md' は従来どおり internal", () => {
    expect(resolveHelpLink('../help/switching.md', context)).toStrictEqual({
      kind: 'internal',
      href: '/plugins/p/help/switching',
    });
  });
});
