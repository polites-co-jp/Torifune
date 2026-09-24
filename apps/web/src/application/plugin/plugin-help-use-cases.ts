import type { PluginHelpDoc } from '@torifune/plugin-api';
import {
  hasPermission,
  requireAuthenticated,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import { NotFoundError } from '@/domain/repository';
import { log } from '@/infrastructure/logging';
import { readPluginHelpFile, type HelpFileFailure } from '@/plugin/help-files';
import { discoverPlugins } from '@/plugin/loader';
import { pluginDir } from '@/plugin/paths';
import { loadedPlugin } from '@/plugin/registry';

/**
 * Plugin の手順書（ヘルプ）の UseCase（041-plugin-help-docs 設計 §6.3・§8）。
 *
 * 手順書は Plugin が同梱する配布物で、インストールのデータ（利用者・投稿・資格情報）を含まない。
 *
 * * **読み込まれた Plugin の手順書は認証済みなら誰でも読める。** 資格情報を入れる
 *   `social.write` の利用者の多くは `plugin.manage` を持たない
 * * **読み込まれていない Plugin（検出済み・無効・再起動待ち）は `plugin.manage` だけ。**
 *   持たなければ `NotFoundError`（`ForbiddenError` にしない。存在を明かさない）
 * * 宣言した `.md` 以外のファイルはどの `docId` でも読めない（`docId` をパスとして使わない）
 */

export interface HelpDocSummary {
  readonly id: string;
  readonly title: string;
  /** `/plugins/<pluginId>/help/<id>` */
  readonly href: string;
}

export interface PluginHelpIndex {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  /** Manifest の宣言の順。1 件以上。 */
  readonly docs: readonly HelpDocSummary[];
  /** 読み込まれて動いているか（画面の注記に使う）。 */
  readonly loaded: boolean;
}

export type PluginHelpDocResult = PluginHelpIndex & {
  readonly doc: HelpDocSummary & { readonly path: string };
  /** 読めたときは本文、読めなければ理由のコード。 */
  readonly content:
    | { readonly ok: true; readonly markdown: string }
    | { readonly ok: false; readonly reason: HelpFileFailure };
};

const REASON =
  '読み込まれた Plugin の手順書は認証済みの誰でも読む（Plugin に同梱された配布物で、インストールのデータを含まない）。読み込まれていない Plugin だけ plugin.manage を中で求める';

export function helpDocHref(pluginId: string, docId: string): string {
  return `/plugins/${pluginId}/help/${docId}`;
}

export function helpDocSummaries(
  pluginId: string,
  help: readonly PluginHelpDoc[] | undefined,
): HelpDocSummary[] {
  return (help ?? []).map((doc) => ({
    id: doc.id,
    title: doc.title,
    href: helpDocHref(pluginId, doc.id),
  }));
}

interface ResolvedHelp {
  readonly help: readonly PluginHelpDoc[];
  readonly index: PluginHelpIndex;
}

/** 設計 §6.3 の 1〜4。読めない場合は例外で止める。 */
function resolveHelp(context: AuthorizationContext, pluginId: string): ResolvedHelp {
  // 1. 未認証は存在の有無より先に断る。
  requireAuthenticated(context);

  // 2. ビルドの登録簿に無い（読み込めなかった・隔離・行だけ・存在しない）→ 404。
  const discovered = discoverPlugins().plugins.find((entry) => entry.manifest.id === pluginId);
  if (discovered === undefined) {
    throw new NotFoundError('Plugin の手順書', pluginId);
  }

  // 3. 読み込まれていない Plugin は plugin.manage だけ。持たなければ 404（存在を明かさない）。
  const loaded = loadedPlugin(pluginId);
  if (loaded === null && !hasPermission(context, 'plugin.manage')) {
    throw new NotFoundError('Plugin の手順書', pluginId);
  }

  // 4. 手順書の宣言が無い（形の誤りで捨てられたものを含む）→ 404。
  const manifest = loaded?.manifest ?? discovered.manifest;
  const help = manifest.help ?? [];
  if (help.length === 0) {
    throw new NotFoundError('Plugin の手順書', pluginId);
  }

  return {
    help,
    index: {
      pluginId,
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      docs: helpDocSummaries(pluginId, help),
      loaded: loaded !== null,
    },
  };
}

/** 手順書の一覧。 */
export const getPluginHelpIndex = defineUseCase<{ pluginId: string }, PluginHelpIndex>({
  name: 'plugin.help.index',
  permission: null,
  reason: REASON,
  handler: async (context, input) => resolveHelp(context, input.pluginId).index,
});

/** 手順書の本文。 */
export const getPluginHelpDoc = defineUseCase<
  { pluginId: string; docId: string },
  PluginHelpDocResult
>({
  name: 'plugin.help.get',
  permission: null,
  reason: REASON,
  handler: async (context, input) => {
    const { help, index } = resolveHelp(context, input.pluginId);

    // 5. 宣言の id と一致するものだけ。**docId をパスとして使わない**（宣言の path だけを読む）。
    const doc = help.find((candidate) => candidate.id === input.docId);
    if (doc === undefined) {
      throw new NotFoundError('Plugin の手順書', input.pluginId);
    }

    // 6. 読めなくても例外にしない。ログにはパス・OS の文言を載せない。
    const content = await readPluginHelpFile(pluginDir(input.pluginId), doc.path);
    if (!content.ok) {
      log.warn('plugin help could not be read', {
        pluginId: input.pluginId,
        docId: doc.id,
        reason: content.reason,
      });
    }

    return {
      ...index,
      doc: {
        id: doc.id,
        title: doc.title,
        href: helpDocHref(input.pluginId, doc.id),
        path: doc.path,
      },
      content,
    };
  },
});

/**
 * provider → 先頭の手順書のリンク（設計 §7.4）。いま読み込まれている Plugin だけを見る。
 *
 * 認可を持たない純粋な引き当て：返すのは「読み込まれた Plugin の手順書の題名と URL」で、
 * それは認証済みの誰でも読める。呼ぶのは `/social` の Server Component（認証済み）だけ。
 * **ファイルの有無は見ない**（`/social` を描くたびにファイルを触らない）。
 */
export function helpLinkOfPlugin(pluginId: string): HelpDocSummary | null {
  const first = loadedPlugin(pluginId)?.manifest.help?.[0];
  if (first === undefined) {
    return null;
  }
  return { id: first.id, title: first.title, href: helpDocHref(pluginId, first.id) };
}
