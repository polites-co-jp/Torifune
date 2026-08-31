import { notFound } from 'next/navigation';
import { findPage, loadedPlugin } from '@/plugin/registry';
import { AppShell } from '@/ui/layout/app-shell';
import { PluginBoundary } from '@/ui/plugin/plugin-boundary';
import { requestDataApi } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * Plugin のページ（決定事項 D-07、06_画面設計.md §20）。
 *
 * catch-all を1枚だけ置き、レジストリからページを解決する。
 * ルートファイルの自動生成が要らず、**未登録・無効・権限不足の判定を
 * 1箇所へ集められる**（同 §24, §30）。
 */
export default async function PluginPage({
  params,
}: {
  params: Promise<{ pluginId: string; rest?: string[] }>;
}) {
  const { pluginId, rest } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  // 未導入・無効な Plugin は存在しないものとして扱う。
  // 「無効です」と返すと、どの Plugin が入っているかを未認可の相手へ教える。
  if (loadedPlugin(pluginId) === null) {
    notFound();
  }

  const route = `/plugins/${pluginId}${rest === undefined || rest.length === 0 ? '' : `/${rest.join('/')}`}`;
  const page = findPage(pluginId, route);

  if (page === null) {
    notFound();
  }

  // **画面を隠すだけにしない。** URL を直接叩かれてもここで止める。
  //
  // 「無い」ではなく「権限が無い」と返す。導入済みの Plugin は
  // 同じインスタンスの利用者から隠すものではなく、
  // 隠すと利用者は理由が分からないまま行き止まりになる。
  if (page.permission !== undefined && !permissions.has(page.permission)) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const Component = page.component as (props: Record<string, unknown>) => React.ReactNode;

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      {/*
        **その要求の Data API を渡す。** activate() の時点の Data API は
        そのとき起動したユーザーの権限に縛られており、
        画面の描画で使うと見ている人と違う権限で読むことになる。
      */}
      <PluginBoundary pluginId={pluginId} label="ページ">
        <Component pluginId={pluginId} route={route} data={requestDataApi(pluginId, context)} />
      </PluginBoundary>
    </AppShell>
  );
}
