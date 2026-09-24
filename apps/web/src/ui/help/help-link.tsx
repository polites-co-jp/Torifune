import { HELP_LINK_PREFIX, HELP_NEW_TAB_NOTE, HELP_NEW_TAB_SR } from './labels';

/**
 * ヘルプボタン（041-plugin-help-docs 設計 §7.4.2）。手順書を**新しいタブ**で開くリンク。
 *
 * 利用者は Modal やフォームに入力している最中で、同じタブで移ると入力が消える。
 * `rel` は外部リンクと同じ `noopener noreferrer`（`window.opener` を渡す理由が無い）。
 *
 * **クライアント側の部品（`/social` の Modal）から import される。**
 * Markdown の描画の部品・解釈器をここから import しない（ブラウザのバンドルに入る）。
 */

export interface HelpLinkProps {
  readonly href: string;
  readonly title: string;
  /** 注記「新しいタブで開きます。…」をリンクの下に出すか（既定は出す）。一覧で 1 回にまとめるときに偽。 */
  readonly showNote?: boolean;
}

export function HelpLink(props: HelpLinkProps) {
  return (
    <>
      <a href={props.href} target="_blank" rel="noopener noreferrer" className="tf-help-link">
        <span aria-hidden="true">？</span> {HELP_LINK_PREFIX}
        {props.title}
        <span aria-hidden="true"> ↗</span>
        <span className="tf-visually-hidden">{HELP_NEW_TAB_SR}</span>
      </a>
      {props.showNote !== false && <p className="tf-help-link-note">{HELP_NEW_TAB_NOTE}</p>}
    </>
  );
}
