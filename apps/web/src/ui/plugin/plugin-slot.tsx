import type { PluginDataApi } from '@torifune/plugin-api';
import type { ReactNode } from 'react';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { createPluginDataApi } from '@/plugin/data-api';
import {
  collectActions,
  collectExtensions,
  collectWidgets,
  loadedPlugin,
  type Owned,
} from '@/plugin/registry';

/**
 * Plugin の描画枠（06_画面設計.md §20、03_プラグイン設計.md §9）。
 *
 * 本体の画面は「ここに Plugin が入る」とだけ書き、
 * 何が入るかは知らない。**Plugin ごとの分岐を本体に書かない。**
 *
 * 権限で絞るのは表示制御であって認可ではない（06 §29）。
 * ページへの到達と操作の可否はサーバー側で別途検証する。
 *
 * **描画する部品には、その要求の Data API を渡す。**
 * `activate()` の時点で受け取った Data API は、そのとき起動した
 * ユーザーの権限に縛られている。画面の描画でそれを使うと、
 * 見ている人と違う権限で読むことになる。
 */

type Renderable = (props: Record<string, unknown>) => ReactNode;

/** その Plugin 用の、いま見ているユーザーの権限で動く Data API。 */
export function requestDataApi(pluginId: string, context: AuthorizationContext): PluginDataApi {
  const manifest = loadedPlugin(pluginId)?.manifest;
  return createPluginDataApi({
    pluginId,
    declaredPermissions: new Set(manifest?.permissions ?? []),
    context,
  });
}

function renderAll<T extends { component: unknown }>(
  entries: readonly Owned<T>[],
  context: AuthorizationContext,
  props: Record<string, unknown>,
): ReactNode[] {
  return entries.map(({ pluginId, registration }, index) => {
    const Component = registration.component as Renderable;
    return (
      <Component
        key={`${pluginId}-${index}`}
        {...props}
        pluginId={pluginId}
        data={requestDataApi(pluginId, context)}
      />
    );
  });
}

export interface PluginSlotProps {
  readonly permissions: ReadonlySet<string>;
  /** 描画する部品へ渡す Data API の元になる認可文脈。 */
  readonly context: AuthorizationContext;
  readonly props?: Record<string, unknown>;
}

export interface PluginWidgetsProps extends PluginSlotProps {
  /** `dashboard` `site.detail` など。 */
  readonly location: string;
}

export function PluginWidgets({ location, permissions, context, props = {} }: PluginWidgetsProps) {
  const widgets = collectWidgets(location, permissions);

  if (widgets.length === 0) {
    // 空の枠を描くと、余白だけが残って見た目が崩れる。
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
      {renderAll(widgets, context, props)}
    </div>
  );
}

export interface ExtensionPointProps extends PluginSlotProps {
  /** `site.edit.sidebar` など。 */
  readonly point: string;
}

export function ExtensionPoint({ point, permissions, context, props = {} }: ExtensionPointProps) {
  const extensions = collectExtensions(point, permissions);

  if (extensions.length === 0) {
    return null;
  }

  return (
    <div data-extension-point={point} style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
      {renderAll(extensions, context, props)}
    </div>
  );
}

export interface PluginActionsProps extends PluginSlotProps {
  readonly location: string;
}

export function PluginActions({ location, permissions, context, props = {} }: PluginActionsProps) {
  const actions = collectActions(location, permissions);

  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      data-plugin-actions={location}
      style={{ display: 'flex', gap: 'var(--tf-space-2)', flexWrap: 'wrap' }}
    >
      {renderAll(actions, context, props)}
    </div>
  );
}
