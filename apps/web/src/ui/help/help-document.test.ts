import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PluginHelpDocResult } from '@/application/plugin/plugin-help-use-cases';
import { HelpDocumentView } from './help-document';

/**
 * 手順書の本文の画面の部品 `HelpDocumentView`（041-plugin-help-docs 設計 §6.3・§7.3.4、D9）。
 *
 * 本文の画面は、UseCase の結果の `docs`（宣言の `path` つき）から `HelpLinkContext.docs` を組み、
 * 本文の中の相対リンク（`./<file>.md`）を `/plugins/<id>/help/<docId>` にする。
 * `MarkdownView` の単体のテスト（#26）は `linkContext` を直に渡すので、
 * **部品が結果の `docs` を `linkContext` へ渡していること**はここで確かめる（2 回目の検証の spec 軽微-1）。
 *
 * `id` とファイル名を違えた宣言も置き、`docId` がファイル名からではなく宣言の `path` との対応から
 * 決まることを見る。
 */

const PLUGIN_ID = 'help-demo';

function resultWith(markdown: string): PluginHelpDocResult {
  const credentials = {
    id: 'credentials',
    title: '資格情報の発行手順',
    href: `/plugins/${PLUGIN_ID}/help/credentials`,
    path: 'help/credentials.md',
  };
  const switching = {
    id: 'switch',
    title: '入れ替えの手順',
    href: `/plugins/${PLUGIN_ID}/help/switch`,
    path: 'help/switching-guide.md',
  };
  return {
    pluginId: PLUGIN_ID,
    pluginName: 'ヘルプの見本',
    pluginVersion: '1.0.0',
    loaded: true,
    docs: [credentials, switching],
    doc: credentials,
    content: { ok: true, markdown },
  };
}

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(HelpDocumentView, { result: resultWith(markdown), canManagePlugins: true }),
  );
}

/** `<a …>次へ</a>` の `href`（属性の順を仮定しない）。見つからなければ `undefined`。 */
function hrefOfAnchorWithText(html: string, text: string): string | undefined {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if ((match[2] ?? '').replace(/<[^>]+>/g, '') !== text) continue;
    return /\bhref="([^"]*)"/.exec(match[1] ?? '')?.[1];
  }
  return undefined;
}

describe('HelpDocumentView は結果の docs から本文の相対リンクを解決する（設計 §6.3・§7.3.4。D9）', () => {
  it('本文の [次へ](./switching-guide.md) が /plugins/<id>/help/<docId> のリンクになる', () => {
    const html = render('[次へ](./switching-guide.md)\n');

    expect(hrefOfAnchorWithText(html, '次へ')).toBe(`/plugins/${PLUGIN_ID}/help/switch`);
  });

  it('いま開いている手順書自身への相対リンクも /plugins/<id>/help/<docId> になる', () => {
    const html = render('[この手順書](./credentials.md)\n');

    expect(hrefOfAnchorWithText(html, 'この手順書')).toBe(`/plugins/${PLUGIN_ID}/help/credentials`);
  });
});
