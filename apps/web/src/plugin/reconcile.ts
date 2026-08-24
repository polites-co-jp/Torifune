import { writeFile } from 'node:fs/promises';
import type { Connection } from '@/database/provider';
import { markOperation, openOperations, type PluginOperation } from './operations';
import { quarantineMarkerPath } from './paths';

/**
 * 再起動後の後始末（012-plugin-manager 設計 §7.2）。
 *
 * 再ビルドが失敗すると、`entrypoint.sh` は直前の成功ビルドへ戻して起動する。
 * 戻ったビルドには**新しい Plugin が含まれていない**。
 *
 * 起動時に「閉じていない操作」を見て、対象の Plugin が読み込まれているかで
 * 成否を判定する。判定しないと、画面が「再ビルド中」のまま止まる。
 */

export interface ReconcileDeps {
  readonly connection: Connection;
  /** ビルド成果物に含まれている Plugin ID。 */
  readonly builtPluginIds: ReadonlySet<string>;
}

export interface ReconcileResult {
  readonly succeeded: readonly string[];
  readonly failed: readonly string[];
}

/**
 * ビルドを壊した Plugin を隔離する。
 *
 * **隔離しないと、次の再ビルドも同じ Plugin で失敗し続ける。**
 * ファイルは消さない。消すと原因を調べられなくなる。
 */
async function quarantine(pluginId: string): Promise<boolean> {
  try {
    await writeFile(
      quarantineMarkerPath(pluginId),
      [
        '# この Plugin はビルドを失敗させたため隔離されています。',
        '# ビルド時のレジストリ生成はこのディレクトリを飛ばします。',
        '# 原因を直したら、このファイルを消してから導入し直してください。',
        `# 隔離日時: ${new Date().toISOString()}`,
        '',
      ].join('\n'),
      'utf8',
    );
    return true;
  } catch {
    // ファイルを置けなくても操作は閉じる。
    // 閉じないと、画面が「再ビルド中」のまま止まる。
    return false;
  }
}

function isSatisfied(operation: PluginOperation, built: ReadonlySet<string>): boolean {
  // 導入は「ビルドに入っていれば成功」。削除は「ビルドから消えていれば成功」。
  return operation.kind === 'install'
    ? built.has(operation.pluginId)
    : !built.has(operation.pluginId);
}

export async function reconcileOperations(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { connection, builtPluginIds } = deps;
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const operation of await openOperations(connection)) {
    if (operation.status === 'pending') {
      // 再起動を要求する前に落ちた。ファイルの状態が確かでないため閉じる。
      await markOperation(connection, operation.id, 'failed', '再起動の前に中断された');
      failed.push(operation.pluginId);
      continue;
    }

    if (isSatisfied(operation, builtPluginIds)) {
      await markOperation(connection, operation.id, 'succeeded');
      succeeded.push(operation.pluginId);
      continue;
    }

    // ビルドが失敗し、直前の成功ビルドへ戻って起動した。
    if (operation.kind === 'install') {
      const isolated = await quarantine(operation.pluginId);
      await connection.db.deleteFrom('plugins').where('id', '=', operation.pluginId).execute();

      await markOperation(
        connection,
        operation.id,
        'failed',
        isolated
          ? 'ビルドに失敗した。直前の状態へ戻し、この Plugin を隔離した。'
          : 'ビルドに失敗した。直前の状態へ戻した。Plugin を隔離できなかったため、ファイルを手で取り除く必要がある。',
      );
    } else {
      await markOperation(
        connection,
        operation.id,
        'failed',
        'ビルドに失敗した。直前の状態へ戻した。',
      );
    }

    failed.push(operation.pluginId);
  }

  return { succeeded, failed };
}
