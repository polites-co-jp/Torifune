import { uuidv7 } from 'uuidv7';
import type { Connection } from '@/database/provider';

/**
 * Plugin の導入・削除の操作記録（012-plugin-manager 設計 §6）。
 *
 * **再起動を跨いで結果を伝えるために要る。**
 * 再ビルドの最中はプロセスが落ちているため、メモリ上の進行状況は消える。
 *
 * 有効化・無効化はここに載せない。再ビルドが要らず、その場で終わる。
 */

export type OperationKind = 'install' | 'uninstall';
export type OperationStatus = 'pending' | 'restarting' | 'succeeded' | 'failed';

export interface PluginOperation {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly message: string | null;
  readonly requestedBy: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

interface Row {
  readonly id: string;
  readonly plugin_id: string;
  readonly kind: string;
  readonly status: string;
  readonly message: string | null;
  readonly requested_by: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
}

function toOperation(row: Row): PluginOperation {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    kind: row.kind as OperationKind,
    status: row.status as OperationStatus,
    message: row.message,
    requestedBy: row.requested_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function startOperation(
  connection: Connection,
  input: { pluginId: string; kind: OperationKind; requestedBy: string },
): Promise<PluginOperation> {
  const row = await connection.db
    .insertInto('plugin_operations')
    .values({
      id: uuidv7(),
      plugin_id: input.pluginId,
      kind: input.kind,
      status: 'pending',
      requested_by: input.requestedBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toOperation(row as Row);
}

export async function markOperation(
  connection: Connection,
  id: string,
  status: OperationStatus,
  message: string | null = null,
): Promise<void> {
  const closed = status === 'succeeded' || status === 'failed';

  await connection.db
    .updateTable('plugin_operations')
    .set({
      status,
      message,
      ...(closed ? { finished_at: new Date() } : {}),
    })
    .where('id', '=', id)
    .execute();
}

export async function findOperation(
  connection: Connection,
  id: string,
): Promise<PluginOperation | null> {
  const row = await connection.db
    .selectFrom('plugin_operations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? null : toOperation(row as Row);
}

/** 閉じていない操作。再起動後の後始末で使う。 */
export async function openOperations(connection: Connection): Promise<readonly PluginOperation[]> {
  const rows = await connection.db
    .selectFrom('plugin_operations')
    .selectAll()
    .where('status', 'in', ['pending', 'restarting'])
    .orderBy('started_at', 'desc')
    .execute();

  return rows.map((row) => toOperation(row as Row));
}

/** 直近の操作。管理画面の表示に使う。 */
export async function recentOperations(
  connection: Connection,
  limit = 20,
): Promise<readonly PluginOperation[]> {
  const rows = await connection.db
    .selectFrom('plugin_operations')
    .selectAll()
    .orderBy('started_at', 'desc')
    .limit(limit)
    .execute();

  return rows.map((row) => toOperation(row as Row));
}
