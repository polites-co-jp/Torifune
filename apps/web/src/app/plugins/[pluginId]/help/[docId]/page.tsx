import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import {
  getPluginHelpDoc,
  type PluginHelpDocResult,
} from '@/application/plugin/plugin-help-use-cases';
import { NotFoundError } from '@/domain/repository';
import { HelpDocumentView } from '@/ui/help/help-document';
import { helpDocPageTitle } from '@/ui/help/labels';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession, type PageSession } from '@/ui/server/page-session';

export const dynamic = 'force-dynamic';

interface Loaded {
  readonly session: PageSession;
  /** 宣言に無い・読めない Plugin など（UseCase の `NotFoundError`）は null。 */
  readonly result: PluginHelpDocResult | null;
}

/**
 * 1 つの要求の中で、題名（`generateMetadata`）と本文で同じ結果を使う。
 * 未認証はここでログイン画面へ移る（`requirePageSession`）。
 */
const load = cache(async (pluginId: string, docId: string): Promise<Loaded> => {
  const session = await requirePageSession();
  try {
    return { session, result: await getPluginHelpDoc(session.context, { pluginId, docId }) };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { session, result: null };
    }
    throw error;
  }
});

type Params = Promise<{ pluginId: string; docId: string }>;

/** ブラウザのタブの題名「手順書の題名 - Plugin名」。読めなければ既定の題名（実装プラン §8 の 9）。 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { pluginId, docId } = await params;
  const { result } = await load(pluginId, docId);
  return result === null ? {} : { title: helpDocPageTitle(result.doc.title, result.pluginName) };
}

/**
 * Plugin の手順書の本文（041-plugin-help-docs 設計 §7.2・§7.3）。
 *
 * 認可は UseCase が行う（一覧と同じ）。本文が読めないときも 200 で、本文の代わりに注記を出す（設計 §7.3.5）。
 */
export default async function PluginHelpDocPage({ params }: { params: Params }) {
  const { pluginId, docId } = await params;
  const { session, result } = await load(pluginId, docId);

  if (result === null) {
    notFound();
  }

  const { displayName, permissions } = session;

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <HelpDocumentView result={result} canManagePlugins={permissions.has('plugin.manage')} />
    </AppShell>
  );
}
