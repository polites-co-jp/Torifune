import type { ReactNode } from 'react';
import { collectActions, collectExtensions, collectWidgets } from '@/plugin/registry';

/**
 * Plugin の描画枠（06_画面設計.md §20、03_プラグイン設計.md §9）。
 *
 * 本体の画面は「ここに Plugin が入る」とだけ書き、
 * 何が入るかは知らない。**Plugin ごとの分岐を本体に書かない。**
 *
 * 権限で絞るのは表示制御であって認可ではない（06 §29）。
 * ページへの到達と操作の可否はサーバー側で別途検証する。
 */

type Renderable = (props: Record<string, unknown>) => ReactNode;

function renderAll(
  entries: readonly { readonly component: unknown }[],
  props: Record<string, unknown>,
): ReactNode[] {
  return entries.map((entry, index) => {
    const Component = entry.component as Renderable;
    // Plugin の描画が例外を投げても本体を落とさないよう、
    // 呼び出し側で ErrorBoundary を掛けられる粒度で並べる。
    return <Component key={index} {...props} />;
  });
}

export interface PluginWidgetsProps {
  /** `dashboard` `site.detail` など。 */
  readonly location: string;
  readonly permissions: ReadonlySet<string>;
  readonly props?: Record<string, unknown>;
}

export function PluginWidgets({ location, permissions, props = {} }: PluginWidgetsProps) {
  const widgets = collectWidgets(location, permissions);

  if (widgets.length === 0) {
    return null;
  }

  return (
    <div
      data-plugin-widgets={location}
      style={{
        display: 'grid',
        gap: 'var(--tf-space-4)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))',
        marginTop: 'var(--tf-space-4)',
      }}
    >
      {renderAll(widgets, props)}
    </div>
  );
}

export interface ExtensionPointProps {
  /** `site.edit.sidebar` など。 */
  readonly point: string;
  readonly permissions: ReadonlySet<string>;
  readonly props?: Record<string, unknown>;
}

export function ExtensionPoint({ point, permissions, props = {} }: ExtensionPointProps) {
  const extensions = collectExtensions(point, permissions);

  if (extensions.length === 0) {
    return null;
  }

  return (
    <div data-extension-point={point} style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
      {renderAll(extensions, props)}
    </div>
  );
}

export interface PluginActionsProps {
  readonly location: string;
  readonly permissions: ReadonlySet<string>;
  readonly props?: Record<string, unknown>;
}

export function PluginActions({ location, permissions, props = {} }: PluginActionsProps) {
  const actions = collectActions(location, permissions);

  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      data-plugin-actions={location}
      style={{ display: 'flex', gap: 'var(--tf-space-2)', flexWrap: 'wrap' }}
    >
      {renderAll(actions, props)}
    </div>
  );
}
