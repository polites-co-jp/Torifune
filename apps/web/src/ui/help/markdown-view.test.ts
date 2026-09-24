import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HelpLinkContext } from './help-links';
import { MarkdownView } from './markdown-view';

/**
 * Markdown の描画（041-plugin-help-docs 設計 §7.3.2・§7.3.4、受け入れ条件 #22〜#29）。
 *
 * **HTML を通さない。** 生の HTML は文字としてエスケープして見せ、画像は描かず
 * 「［画像：alt］」の文字にし、リンクは `resolveHelpLink` の結果で描き分ける。
 * 見出しの `id` は GitHub と同じ規則に `help-` を前置きする。
 *
 * `MarkdownView` は Server Component で使う（`'use client'` を持たない）。
 * 既存の UI のテストと同じく `renderToStaticMarkup` で静的な HTML を見る。
 *
 * 注：`react-markdown` / `remark-gfm` / `rehype-slug` は G1 で依存に足す。
 * 足す前はこのファイルの import が解決できず、全件が落ちる（期待どおりの赤）。
 */

const linkContext: HelpLinkContext = {
  pluginId: 'p',
  currentPath: 'help/credentials.md',
  docs: [
    { id: 'credentials', path: 'help/credentials.md' },
    { id: 'switching', path: 'help/switching.md' },
  ],
};

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { markdown, linkContext }));
}

interface Anchor {
  readonly attributes: Readonly<Record<string, string>>;
  readonly inner: string;
}

/** HTML の中の `<a …>…</a>` を拾う。**属性の順を仮定しない。** */
function anchorsOf(html: string): readonly Anchor[] {
  const anchors: Anchor[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    anchors.push({ attributes: attributesOf(match[1] ?? ''), inner: match[2] ?? '' });
  }
  return anchors;
}

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
    const name = match[1];
    if (name === undefined) continue;
    attributes[name.toLowerCase()] = match[2] ?? '';
  }
  return attributes;
}

/** 開始タグをすべて拾う（`<a …>`・`<h2 …>` など）。 */
function startTagsOf(html: string): readonly string[] {
  return [...html.matchAll(/<[a-zA-Z][^>]*>/g)].map((match) => match[0]);
}

describe('#22 生の HTML はエスケープされ、要素にならない', () => {
  const markdown = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n';

  it('#22 出力に <script も <img も無い', () => {
    const html = render(markdown);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('#22 &lt;script&gt; として文字で見える（消さずに見せる）', () => {
    expect(render(markdown)).toContain('&lt;script&gt;');
  });

  it('#22 段落の中に混ぜた生の HTML も要素にならない', () => {
    const html = render('前 <b onclick="alert(1)">太字</b> 後 <br> 改行\n');

    expect(html).not.toMatch(/<b[\s>]/);
    expect(html).not.toMatch(/<br[\s/>]/);
    expect(html).toContain('&lt;b');
  });
});

describe('#23 画像は描かず文字にする', () => {
  it('#23 ![手順の画面](https://example.com/a.png) → <img が無く「［画像：手順の画面］」が有る', () => {
    const html = render('![手順の画面](https://example.com/a.png)\n');

    expect(html).not.toContain('<img');
    expect(html).toContain('［画像：手順の画面］');
  });

  it('#23 alt が空の ![](./a.png) → <img が無く「［画像］」が有る', () => {
    const html = render('![](./a.png)\n');

    expect(html).not.toContain('<img');
    expect(html).toContain('［画像］');
  });

  it('#23 画像の URL を HTML に出さない（外部へ要求を出す口を作らない）', () => {
    const html = render('![手順の画面](https://example.com/a.png)\n');

    expect(html).not.toContain('https://example.com/a.png');
  });
});

describe('#24 外部のリンク', () => {
  it('#24 [公式](https://docs.x.com/) → target="_blank" rel="noopener noreferrer" の <a>', () => {
    const anchors = anchorsOf(render('[公式](https://docs.x.com/)\n'));

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.attributes).toMatchObject({
      href: 'https://docs.x.com/',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
  });

  it('#24 <a> の内側に文言と「（新しいタブで開きます）」が有る', () => {
    const [anchor] = anchorsOf(render('[公式](https://docs.x.com/)\n'));

    expect(anchor?.inner).toContain('公式');
    expect(anchor?.inner).toContain('（新しいタブで開きます）');
  });

  it('#24 「（新しいタブで開きます）」は視覚的に隠す span に入る', () => {
    const [anchor] = anchorsOf(render('[公式](https://docs.x.com/)\n'));

    expect(anchor?.inner).toMatch(
      /<span[^>]*class="tf-visually-hidden"[^>]*>（新しいタブで開きます）<\/span>/,
    );
  });

  it('#24 GFM の生の URL（文中に直書き）も同じ属性のリンクになる', () => {
    const anchors = anchorsOf(render('公式の説明は https://example.com を開いてください。\n'));

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.attributes['href']).toMatch(/^https:\/\/example\.com\/?$/);
    expect(anchors[0]?.attributes['target']).toBe('_blank');
    expect(anchors[0]?.attributes['rel']).toBe('noopener noreferrer');
    expect(anchors[0]?.inner).toContain('（新しいタブで開きます）');
  });
});

describe('#25 危ないリンクはリンクにしない', () => {
  it('#25 [押す](javascript:alert(1)) → 出力のどこにも javascript: が無い', () => {
    expect(render('[押す](javascript:alert(1))\n')).not.toMatch(/javascript:/i);
  });

  it('#25 文言「押す」は残り、<a> で包まれない', () => {
    const html = render('[押す](javascript:alert(1))\n');

    expect(html).toContain('押す');
    expect(anchorsOf(html)).toHaveLength(0);
  });

  it.each([
    ['大文字小文字の混在', '[x](JaVaScRiPt:alert(1))'],
    ['data:', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['vbscript:', '[x](vbscript:msgbox(1))'],
    ['プロトコル相対', '[x](//evil.example/x)'],
    ['自動リンクの javascript:', '<javascript:alert(1)>'],
    ['参照形式の javascript:', '[x][r]\n\n[r]: javascript:alert(1)'],
  ])('#25 XSS の見本（%s）はリンクにならない', (_label, markdown) => {
    const html = render(`${markdown}\n`);

    expect(anchorsOf(html)).toHaveLength(0);
    expect(html).not.toMatch(/href="(?:javascript|data|vbscript):/i);
    expect(html).not.toContain('href="//');
  });

  it('#25 宣言していない相対リンク（../README.md）は文言だけで、href を HTML に出さない', () => {
    const html = render('[README](../README.md)\n');

    expect(html).toContain('README');
    expect(anchorsOf(html)).toHaveLength(0);
    expect(html).not.toContain('README.md');
  });
});

describe('#26 Torifune の中のリンク', () => {
  it('#26 [次へ](./switching.md) → <a href="/plugins/p/help/switching"> で target が無い', () => {
    const anchors = anchorsOf(render('[次へ](./switching.md)\n'));

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.attributes['href']).toBe('/plugins/p/help/switching');
    expect(Object.keys(anchors[0]?.attributes ?? {})).not.toContain('target');
    expect(anchors[0]?.inner).toContain('次へ');
  });

  it('#26 本文の中の断片 [手順](#手順-1) → href="#help-手順-1" で target が無い', () => {
    const anchors = anchorsOf(render('[手順](#手順-1)\n'));

    expect(anchors).toHaveLength(1);
    expect(decodeURIComponent(anchors[0]?.attributes['href'] ?? '')).toBe('#help-手順-1');
    expect(Object.keys(anchors[0]?.attributes ?? {})).not.toContain('target');
  });

  it('#26 Torifune の中のリンクには「（新しいタブで開きます）」が付かない', () => {
    expect(render('[次へ](./switching.md)\n')).not.toContain('（新しいタブで開きます）');
  });
});

describe('#27 見出し', () => {
  it('#27 本文の先頭の見出し 1 は描かない（画面の h1 は Manifest の title が持つ）', () => {
    const html = render('# 題名\n\n## 手順\n\n## 手順\n');

    expect(html).not.toContain('<h1');
    expect(html).not.toContain('題名');
  });

  it('#27 見出しの id は GitHub と同じ規則に help- を前置きし、同じ文言には -1 が付く', () => {
    const html = render('# 題名\n\n## 手順\n\n## 手順\n');

    expect(html).toContain('<h2 id="help-手順">');
    expect(html).toContain('<h2 id="help-手順-1">');
  });

  it('#27 先頭でない見出し 1（# 別）は h2 で描かれる', () => {
    const html = render('# 題名\n\n本文\n\n# 別\n');

    expect(html).not.toContain('<h1');
    expect(html).toMatch(/<h2[^>]*>別<\/h2>/);
  });

  it('#27 先頭が見出し 1 でなければ、最初の見出し 1 も h2 で描かれ、文言は消えない', () => {
    const html = render('はじめに\n\n# 題名\n');

    expect(html).not.toContain('<h1');
    expect(html).toMatch(/<h2[^>]*>題名<\/h2>/);
  });

  it('#27 見出し 3 はそのままの段（h3）で、id に help- が付く', () => {
    expect(render('# 題名\n\n### 小見出し\n')).toContain('<h3 id="help-小見出し">');
  });

  it('#27 描かない先頭の見出し 1 も GitHub と同じく番号を数える（目次の断片が GitHub と一致する）', () => {
    // GitHub では「# 題名」が描かれて id「題名」を取るので、後の「## 題名」は「題名-1」になる。
    const html = render('# 題名\n\n## 題名\n');

    expect(html).toContain('<h2 id="help-題名-1">');
  });
});

describe('#28 表', () => {
  it('#28 GFM の表は <div class="tf-table-scroll"><table> の形で描く', () => {
    const html = render('| 欄 | 値 |\n| --- | --- |\n| ハンドル | example.bsky.social |\n');

    expect(html).toMatch(/<div class="tf-table-scroll"><table[\s>]/);
    expect(html).toContain('ハンドル');
  });
});

describe('#29 コード', () => {
  it('#29 囲みのコードの中の <b>x</b> は <pre><code…> の中で &lt;b&gt; にエスケープされる', () => {
    const html = render('```bash\n<b>x</b>\n```\n');

    expect(html).toMatch(/<pre><code[^>]*>[\s\S]*&lt;b&gt;x&lt;\/b&gt;[\s\S]*<\/code><\/pre>/);
    expect(html).not.toMatch(/<b[\s>]/);
  });

  it('#29 インラインのコードも <code> の中でエスケープされる', () => {
    const html = render('値は `<script>` のように書かない\n');

    expect(html).toContain('<code>&lt;script&gt;</code>');
    expect(html).not.toContain('<script');
  });
});

describe('XSS の見本をまとめて描いても、実行できる形が 1 つも出ない（#22・#25）', () => {
  const samples = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '[x](  javascript:alert(1)  )',
    '[x](java&#x09;script:alert(1))',
    '![x](javascript:alert(1))',
    '<details open ontoggle=alert(1)>',
    '<style>body{display:none}</style>',
  ].join('\n\n');

  it('開始タグに on…= の属性・script・iframe・svg・style・img が無い', () => {
    const tags = startTagsOf(render(`${samples}\n`));

    for (const tag of tags) {
      expect(tag).not.toMatch(/\son[a-z]+=/i);
      expect(tag).not.toMatch(/^<(script|iframe|svg|style|img|details)\b/i);
    }
  });

  it('どの href も javascript: / data: / vbscript: / プロトコル相対でない', () => {
    for (const anchor of anchorsOf(render(`${samples}\n`))) {
      const href = anchor.attributes['href'] ?? '';
      expect(href).not.toMatch(/^\s*(javascript|data|vbscript):/i);
      expect(href.startsWith('//')).toBe(false);
    }
  });
});
