import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginSettingsHelp } from './plugin-settings-help';

/**
 * 設定画面の手順書の部分（041-plugin-help-docs 設計 §7.5、受け入れ条件 #52）。
 *
 * 設定画面 `/plugins/<id>/settings` は、読み込まれた Plugin が設定か手順書の少なくとも一方を持つときに出る。
 *
 * ```text
 * h1：<Plugin名>
 * [手順書]（helpDocs が 1 件以上のとき。Card、見出し「手順書」）
 *    ？ 手順書：<題名 1> ↗
 *    ？ 手順書：<題名 2> ↗        （HelpLink。新しいタブ）
 * [設定]（settings があるとき）→ 既存の PluginSettingsForm
 * [Alert info]（settings が無いとき）この Plugin には、この画面で変える設定がありません。
 * ```
 *
 * 部品は `ui/help/plugin-settings-help.tsx` の `PluginSettingsHelp({ helpDocs, hasSettings })`
 * （実装プラン §8 の 5・T15）。設定のフォームはこの部品の外（ページ）が描く。
 * 注記「新しいタブで開きます。…」はリンクごとではなく一覧の下に 1 回（実装プラン §8 の 11）。
 */

interface HelpDoc {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

const FIRST: HelpDoc = {
  id: 'credentials',
  title: '資格情報の発行手順',
  href: '/plugins/help-demo/help/credentials',
};

const SECOND: HelpDoc = {
  id: 'switching',
  title: '入れ替えの手順',
  href: '/plugins/help-demo/help/switching',
};

const NO_SETTINGS = 'この Plugin には、この画面で変える設定がありません。';
const HEADING = '手順書';
const NEW_TAB_NOTE = '新しいタブで開きます。入力中の内容はこの画面に残ります。';

function render(props: { helpDocs: readonly HelpDoc[]; hasSettings: boolean }): string {
  return renderToStaticMarkup(createElement(PluginSettingsHelp, props));
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributeOf(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

interface Anchor {
  readonly tag: string;
  readonly text: string;
}

function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a(\s[^>]*)?>([\s\S]*?)<\/a>/g)].map((match) => ({
    tag: match[0].slice(0, match[0].indexOf('>') + 1),
    text: textOf(match[2] ?? ''),
  }));
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('#52 手順書の一覧：宣言の順に、新しいタブで開くリンクが並ぶ', () => {
  it('#52 手順書 2 件 → リンクが 2 つ、宣言の順の href', () => {
    const html = render({ helpDocs: [FIRST, SECOND], hasSettings: true });

    expect(anchors(html).map((anchor) => attributeOf(anchor.tag, 'href'))).toEqual([
      FIRST.href,
      SECOND.href,
    ]);
  });

  it('#52 宣言の順を入れ替えると、リンクの順も入れ替わる', () => {
    const html = render({ helpDocs: [SECOND, FIRST], hasSettings: true });

    expect(anchors(html).map((anchor) => attributeOf(anchor.tag, 'href'))).toEqual([
      SECOND.href,
      FIRST.href,
    ]);
  });

  it('#52 各リンクの文言に題名がある（宣言の順）', () => {
    const [first, second] = anchors(render({ helpDocs: [FIRST, SECOND], hasSettings: true }));

    expect(first?.text ?? '').toContain(FIRST.title);
    expect(second?.text ?? '').toContain(SECOND.title);
  });

  it('#52 各リンクは target="_blank"', () => {
    for (const anchor of anchors(render({ helpDocs: [FIRST, SECOND], hasSettings: true }))) {
      expect(attributeOf(anchor.tag, 'target'), anchor.text).toBe('_blank');
    }
  });

  it('#52 各リンクは rel="noopener noreferrer"', () => {
    for (const anchor of anchors(render({ helpDocs: [FIRST, SECOND], hasSettings: true }))) {
      expect(attributeOf(anchor.tag, 'rel'), anchor.text).toBe('noopener noreferrer');
    }
  });

  it('#52 見出し「手順書」がある', () => {
    const html = render({ helpDocs: [FIRST], hasSettings: true });

    expect(html).toMatch(new RegExp(`<h[2-6][^>]*>\\s*${HEADING}\\s*</h[2-6]>`));
  });

  it('#52 新しいタブの注記は一覧の下に 1 回だけ', () => {
    const text = textOf(render({ helpDocs: [FIRST, SECOND], hasSettings: true }));

    expect(occurrences(text, NEW_TAB_NOTE)).toBe(1);
  });

  it('#52 注記は最後のリンクより後にある', () => {
    const html = render({ helpDocs: [FIRST, SECOND], hasSettings: true });

    expect(html.indexOf(NEW_TAB_NOTE)).toBeGreaterThan(html.lastIndexOf(SECOND.href));
  });
});

describe('#52 手順書が無ければ一覧を出さない', () => {
  it('#52 helpDocs: [] → リンクが 0 個', () => {
    expect(anchors(render({ helpDocs: [], hasSettings: true }))).toHaveLength(0);
  });

  it('#52 helpDocs: [] → 見出し「手順書」も注記も無い', () => {
    const html = render({ helpDocs: [], hasSettings: true });

    expect(html).not.toMatch(new RegExp(`<h[2-6][^>]*>\\s*${HEADING}\\s*</h[2-6]>`));
    expect(textOf(html)).not.toContain(NEW_TAB_NOTE);
  });
});

describe('#52 設定の有無', () => {
  it('#52 設定が無い（settings: null）→「この Plugin には、この画面で変える設定がありません。」がある', () => {
    expect(textOf(render({ helpDocs: [FIRST], hasSettings: false }))).toContain(NO_SETTINGS);
  });

  it('#52 設定が無い → フォームが無い', () => {
    const html = render({ helpDocs: [FIRST], hasSettings: false });

    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });

  it('#52 設定がある → 「設定がありません」の注記が無い', () => {
    expect(textOf(render({ helpDocs: [FIRST], hasSettings: true }))).not.toContain(NO_SETTINGS);
  });

  it('#52 手順書の一覧は「設定がありません」の注記より上にある（先に読むもの）', () => {
    const html = render({ helpDocs: [FIRST], hasSettings: false });

    expect(html.indexOf(NO_SETTINGS)).toBeGreaterThan(html.indexOf(FIRST.href));
  });
});
