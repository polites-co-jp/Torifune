import Link from 'next/link';
import type { ReactNode } from 'react';
import type {
  HelpDocSummary,
  PluginHelpDocResult,
  PluginHelpIndex,
} from '@/application/plugin/plugin-help-use-cases';
import { Alert } from '@/ui/components';
import { MarkdownView } from './markdown-view';
import {
  HELP_BACK_TO_SETTINGS,
  HELP_BREADCRUMB_HELP,
  HELP_BREADCRUMB_LABEL,
  HELP_BREADCRUMB_PLUGINS,
  HELP_BUNDLED_NOTE,
  HELP_PLUGIN_NOT_LOADED,
  HELP_READ_FAILED,
  HELP_SIBLINGS_HEADING,
  helpDocSubtitle,
  helpIndexHeading,
} from './labels';

/**
 * 手順書の画面の組み（041-plugin-help-docs 設計 §7.3.1）。
 *
 * **Server Component のまま使う**（Markdown の描画をブラウザへ送らない）。
 * 認可の判断はしない。UseCase が通した結果だけを受け取って描く。
 * 画面の中のリンク（パンくず・同じ Plugin の手順書・設定へ戻る）は**同じタブ**で開く。
 */

const SEPARATOR_STYLE = { color: 'var(--tf-color-text-muted)' } as const;

interface BreadcrumbProps {
  readonly pluginId: string;
  readonly pluginName: string;
  /** プラグインの管理画面へのリンクにするか（`plugin.manage` のときだけ）。 */
  readonly canManagePlugins: boolean;
  /** 「手順書」を一覧へのリンクにするか（本文の画面では真、一覧の画面では偽）。 */
  readonly linkToIndex: boolean;
}

function Separator() {
  return (
    <span aria-hidden="true" style={SEPARATOR_STYLE}>
      ›
    </span>
  );
}

/** パンくず：プラグイン › Plugin名 › 手順書（実装プラン §8 の 12）。 */
function Breadcrumb(props: BreadcrumbProps) {
  return (
    <nav aria-label={HELP_BREADCRUMB_LABEL} style={{ marginBottom: 'var(--tf-space-3)' }}>
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--tf-space-2)',
          listStyle: 'none',
          margin: 0,
          padding: 0,
          fontSize: 'var(--tf-text-caption)',
        }}
      >
        <li>
          {props.canManagePlugins ? (
            <Link href="/plugins">{HELP_BREADCRUMB_PLUGINS}</Link>
          ) : (
            <span>{HELP_BREADCRUMB_PLUGINS}</span>
          )}
        </li>
        <li aria-hidden="true">
          <Separator />
        </li>
        <li>
          <span>{props.pluginName}</span>
        </li>
        <li aria-hidden="true">
          <Separator />
        </li>
        <li>
          {props.linkToIndex ? (
            <Link href={`/plugins/${props.pluginId}/help`}>{HELP_BREADCRUMB_HELP}</Link>
          ) : (
            <span aria-current="page">{HELP_BREADCRUMB_HELP}</span>
          )}
        </li>
      </ol>
    </nav>
  );
}

function Subtitle(props: { readonly children: ReactNode }) {
  return (
    <p
      style={{
        margin: '0 0 var(--tf-space-4)',
        color: 'var(--tf-color-text-muted)',
        fontSize: 'var(--tf-text-caption)',
      }}
    >
      {props.children}
    </p>
  );
}

function Notices(props: { readonly loaded: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-3)', marginBottom: 'var(--tf-space-6)' }}>
      <Alert tone="info">{HELP_BUNDLED_NOTE}</Alert>
      {!props.loaded && <Alert tone="warning">{HELP_PLUGIN_NOT_LOADED}</Alert>}
    </div>
  );
}

const TITLE_STYLE = { fontSize: '1.25rem', margin: '0 0 var(--tf-space-1)' } as const;

export interface HelpIndexViewProps {
  readonly index: PluginHelpIndex;
  readonly canManagePlugins: boolean;
}

/** 手順書の一覧（`/plugins/<id>/help`）。宣言の順の題名のリンクだけ。 */
export function HelpIndexView({ index, canManagePlugins }: HelpIndexViewProps) {
  return (
    <>
      <Breadcrumb
        pluginId={index.pluginId}
        pluginName={index.pluginName}
        canManagePlugins={canManagePlugins}
        linkToIndex={false}
      />
      <h1 style={TITLE_STYLE}>{helpIndexHeading(index.pluginName)}</h1>
      <Subtitle>{helpDocSubtitle(index.pluginName, index.pluginId, index.pluginVersion)}</Subtitle>
      <Notices loaded={index.loaded} />
      <ul style={{ margin: 0, paddingLeft: 'var(--tf-space-6)', lineHeight: 1.9 }}>
        {index.docs.map((doc) => (
          <li key={doc.id}>
            <Link href={doc.href}>{doc.title}</Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 同じ Plugin の手順書（2 本以上のとき）。いま開いているものは太字でリンクにしない。 */
function Siblings(props: { readonly docs: readonly HelpDocSummary[]; readonly currentId: string }) {
  return (
    <nav aria-labelledby="tf-help-siblings-heading" style={{ marginBottom: 'var(--tf-space-6)' }}>
      <h2
        id="tf-help-siblings-heading"
        style={{
          fontSize: 'var(--tf-text-body)',
          fontWeight: 600,
          margin: '0 0 var(--tf-space-2)',
        }}
      >
        {HELP_SIBLINGS_HEADING}
      </h2>
      <ul style={{ margin: 0, paddingLeft: 'var(--tf-space-6)' }}>
        {props.docs.map((doc) => (
          <li key={doc.id}>
            {doc.id === props.currentId ? (
              <strong aria-current="page">{doc.title}</strong>
            ) : (
              <Link href={doc.href}>{doc.title}</Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface HelpDocumentViewProps {
  readonly result: PluginHelpDocResult;
  /** 同じ Plugin の宣言（id と path）。本文の中の相対リンクの解決に使う（設計 §7.3.4）。 */
  readonly docPaths: readonly { readonly id: string; readonly path: string }[];
  readonly canManagePlugins: boolean;
}

/** 手順書の本文（`/plugins/<id>/help/<docId>`）。 */
export function HelpDocumentView({ result, docPaths, canManagePlugins }: HelpDocumentViewProps) {
  return (
    <>
      <Breadcrumb
        pluginId={result.pluginId}
        pluginName={result.pluginName}
        canManagePlugins={canManagePlugins}
        linkToIndex
      />
      <h1 style={TITLE_STYLE}>{result.doc.title}</h1>
      <Subtitle>
        {helpDocSubtitle(result.pluginName, result.pluginId, result.pluginVersion)}
      </Subtitle>
      <Notices loaded={result.loaded} />

      {result.docs.length >= 2 && <Siblings docs={result.docs} currentId={result.doc.id} />}

      {result.content.ok ? (
        <article>
          <MarkdownView
            markdown={result.content.markdown}
            linkContext={{
              pluginId: result.pluginId,
              currentPath: result.doc.path,
              docs: docPaths,
            }}
          />
        </article>
      ) : (
        // 理由のコード・パスは画面に出さない（ログにだけ残る。設計 §7.3.5）。
        <Alert tone="danger">{HELP_READ_FAILED}</Alert>
      )}

      {/* 手順書を持つ読み込まれた Plugin は必ず設定画面を持つ（設計 §7.5・実装プラン §8 の 12）。 */}
      {canManagePlugins && result.loaded && (
        <p style={{ marginTop: 'var(--tf-space-8)' }}>
          <Link href={`/plugins/${result.pluginId}/settings`}>{HELP_BACK_TO_SETTINGS}</Link>
        </p>
      )}
    </>
  );
}
