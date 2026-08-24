import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withConnection } from '@/application/transaction';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { installPlugin } from './lifecycle';
import { findOperation, markOperation, startOperation } from './operations';
import { QUARANTINE_MARKER } from './paths';
import { reconcileOperations } from './reconcile';

let scratch: ScratchDatabase;
let userId: string;
let workDir: string;

async function createUser(): Promise<string> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  await withConnection((connection) =>
    connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `c${suffix}`,
        email: `c${suffix}@example.com`,
        display_name: 'reconcile test',
      })
      .execute(),
  );
  return id;
}

async function seedPluginDir(pluginId: string): Promise<void> {
  await mkdir(join(workDir, pluginId), { recursive: true });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('reconcile');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'torifune-plugins-'));
  process.env['TORIFUNE_PLUGINS_DIR'] = workDir;
  userId = await createUser();
});

afterEach(async () => {
  delete process.env['TORIFUNE_PLUGINS_DIR'];
  await rm(workDir, { recursive: true, force: true });
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('plugin_operations').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('再起動後の後始末', () => {
  it('導入が反映されていれば succeeded にする', async () => {
    const operation = await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'sample-plugin',
        kind: 'install',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
      return created;
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set(['sample-plugin']) }),
    );

    const after = await withConnection((c) => findOperation(c, operation.id));
    expect(after?.status).toBe('succeeded');
    expect(after?.finishedAt).not.toBeNull();
  });

  it('反映されていなければ failed にする', async () => {
    // ビルドが失敗し、直前の成功ビルドへ戻って起動した。
    await seedPluginDir('broken-plugin');

    const operation = await withConnection(async (connection) => {
      await installPlugin(connection, {
        id: 'broken-plugin',
        name: 'broken',
        version: '1.0.0',
        apiVersion: 1,
      });
      const created = await startOperation(connection, {
        pluginId: 'broken-plugin',
        kind: 'install',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
      return created;
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set() }),
    );

    const after = await withConnection((c) => findOperation(c, operation.id));
    expect(after?.status).toBe('failed');
    expect(after?.message).toContain('ビルドに失敗');
  });

  it('ビルドを壊した Plugin を隔離する', async () => {
    // 隔離しないと、次の再ビルドも同じ Plugin で失敗し続ける。
    await seedPluginDir('broken-plugin');

    await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'broken-plugin',
        kind: 'install',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set() }),
    );

    const marker = join(workDir, 'broken-plugin', QUARANTINE_MARKER);
    await expect(stat(marker)).resolves.toBeDefined();
  });

  it('隔離しても Plugin のファイルは消さない', async () => {
    // 消すと原因を調べられなくなる。
    await seedPluginDir('broken-plugin');

    await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'broken-plugin',
        kind: 'install',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set() }),
    );

    expect(await readdir(workDir)).toContain('broken-plugin');
  });

  it('失敗した導入の行を消す', async () => {
    // 残すと、動いていない Plugin が「導入済み」に見える。
    await seedPluginDir('broken-plugin');

    await withConnection(async (connection) => {
      await installPlugin(connection, {
        id: 'broken-plugin',
        name: 'broken',
        version: '1.0.0',
        apiVersion: 1,
      });
      const created = await startOperation(connection, {
        pluginId: 'broken-plugin',
        kind: 'install',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set() }),
    );

    const rows = await withConnection((c) => c.db.selectFrom('plugins').selectAll().execute());
    expect(rows).toEqual([]);
  });

  it('削除がビルドに反映されていれば succeeded にする', async () => {
    const operation = await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'gone-plugin',
        kind: 'uninstall',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
      return created;
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set(['other-plugin']) }),
    );

    const after = await withConnection((c) => findOperation(c, operation.id));
    expect(after?.status).toBe('succeeded');
  });

  it('削除が反映されていなければ failed にする', async () => {
    const operation = await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'still-here',
        kind: 'uninstall',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
      return created;
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set(['still-here']) }),
    );

    const after = await withConnection((c) => findOperation(c, operation.id));
    expect(after?.status).toBe('failed');
  });

  it('削除の失敗では隔離しない', async () => {
    // 削除に失敗しただけの Plugin を隔離すると、動いていたものが止まる。
    await seedPluginDir('still-here');

    await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'still-here',
        kind: 'uninstall',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'restarting');
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set(['still-here']) }),
    );

    expect(await readdir(join(workDir, 'still-here'))).toEqual([]);
  });

  it('再起動の前に落ちた操作を閉じる', async () => {
    // 閉じないと、画面が「再ビルド中」のまま止まる。
    const operation = await withConnection((connection) =>
      startOperation(connection, {
        pluginId: 'sample-plugin',
        kind: 'install',
        requestedBy: userId,
      }),
    );

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set() }),
    );

    const after = await withConnection((c) => findOperation(c, operation.id));
    expect(after?.status).toBe('failed');
    expect(after?.message).toContain('中断');
  });

  it('閉じた操作は触らない', async () => {
    const operation = await withConnection(async (connection) => {
      const created = await startOperation(connection, {
        pluginId: 'sample-plugin',
        kind: 'install',
        requestedBy: userId,
      });
      await markOperation(connection, created.id, 'succeeded', 'そのまま');
      return created;
    });

    await withConnection((connection) =>
      reconcileOperations({ connection, builtPluginIds: new Set() }),
    );

    const after = await withConnection((c) => findOperation(c, operation.id));
    expect(after?.status).toBe('succeeded');
    expect(after?.message).toBe('そのまま');
  });
});
