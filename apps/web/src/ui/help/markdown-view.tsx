import type { ReactElement, ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { HELP_HEADING_ID_PREFIX, resolveHelpLink, type HelpLinkContext } from './help-links';
import {
  HELP_FOOTNOTE_BACK_LABEL,
  HELP_FOOTNOTE_LABEL,
  HELP_NEW_TAB_SR,
  imagePlaceholder,
} from './labels';

/**
 * 手順書の Markdown を React の要素に描く（041-plugin-help-docs 設計 §7.3.2）。
 *
 * **Server Component の中で使う。** この部品はクライアント指定を持たず、
 * クライアント側の部品から import しない（Markdown の解釈器をブラウザへ送らない）。
 *
 * **HTML の文字列を経由しない。** 手順書の中の生の HTML は解釈せず、文字として見せる
 * （`react-markdown` の既定。HTML を要素にする rehype の処理は入れない）。
 * 画像は描かず文字にし、リンクは `resolveHelpLink` の結果で描き分ける。
 * `urlTransform` は既定のまま（危ないスキームは既定の変換でも空になる。二重の守り）。
 */

export interface MarkdownViewProps {
  readonly markdown: string;
  /** リンクの解決に使う（設計 §7.3.4）。 */
  readonly linkContext: HelpLinkContext;
}

/** hast の木のうち、この部品が触る形だけ（`@types/hast` へ直接依存しない）。 */
interface HastNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  children?: HastNode[];
}

/**
 * GFM の脚注の参照・戻りのリンクか（`remark-rehype` が `data-footnote-ref` / `data-footnote-backref` を付ける）。
 *
 * これらの `href` は `remark-rehype` が作った `#user-content-…` で、`resolveHelpLink` に通すと
 * `#help-user-content-…` に書き換わって行き先が無くなる（設計 §7.3.2・D10）。
 */
function isFootnoteLink(node: HastNode | undefined): boolean {
  const properties = node?.properties;
  return (
    properties !== undefined &&
    (properties['dataFootnoteRef'] !== undefined || properties['dataFootnoteBackref'] !== undefined)
  );
}

/**
 * **本文の先頭のブロックが見出し 1 なら取り除く。**
 *
 * 画面の h1 は Manifest の `title` が持つ。手順書は GitHub で読んでも題名が出るように
 * `#` の題名から書き始める。**`rehype-slug` の後に走らせる**：先に消すと、
 * 題名と同じ文言の見出しの番号（`-1`）が GitHub と食い違う。
 */
function rehypeDropLeadingH1() {
  return (tree: HastNode): void => {
    const children = tree.children;
    if (children === undefined) return;
    const index = children.findIndex(
      (node) => !(node.type === 'text' && (node.value ?? '').trim() === ''),
    );
    const first = index === -1 ? undefined : children[index];
    if (first !== undefined && first.type === 'element' && first.tagName === 'h1') {
      children.splice(index, 1);
    }
  };
}

function ExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
      <span aria-hidden="true"> ↗</span>
      <span className="tf-visually-hidden">{HELP_NEW_TAB_SR}</span>
    </a>
  );
}

function componentsFor(linkContext: HelpLinkContext): Components {
  return {
    // 先頭でない見出し 1 は h2 で描く（画面に h1 を 1 つだけにする）。
    h1: ({ node: _node, ...props }) => <h2 {...props} />,
    a: ({ node, href, children, ...rest }) => {
      if (isFootnoteLink(node as HastNode | undefined)) {
        // 作られた href のまま、同じタブで描く（本文の中の移動。外へ出ない）。
        return (
          <a href={href} {...rest}>
            {children}
          </a>
        );
      }
      const resolved = resolveHelpLink(href ?? '', linkContext);
      switch (resolved.kind) {
        case 'external':
          return <ExternalLink href={resolved.href}>{children}</ExternalLink>;
        case 'internal':
          // Next.js の Link は使わない（手順書の中のリンクは少なく、先読みの要求を増やさない）。
          return <a href={resolved.href}>{children}</a>;
        case 'none':
          // href を HTML に出さない。
          return <span>{children}</span>;
      }
    },
    // CSP が外部の画像を止め、同梱の画像を配る経路も無い。画像は文字で示す。
    img: ({ alt }) => <>{imagePlaceholder(alt)}</>,
    // 狭い画面では表の中で横に動かす（06_画面設計.md §31）。
    table: ({ children }) => (
      <div className="tf-table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

export function MarkdownView(props: MarkdownViewProps): ReactElement {
  return (
    <div className="tf-help-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{
          footnoteLabel: HELP_FOOTNOTE_LABEL,
          footnoteBackLabel: HELP_FOOTNOTE_BACK_LABEL,
        }}
        rehypePlugins={[[rehypeSlug, { prefix: HELP_HEADING_ID_PREFIX }], rehypeDropLeadingH1]}
        components={componentsFor(props.linkContext)}
      >
        {props.markdown}
      </Markdown>
    </div>
  );
}
