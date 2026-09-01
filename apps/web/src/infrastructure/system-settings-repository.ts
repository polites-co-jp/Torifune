import type { Connection } from '../database/provider';

/**
 * システム設定の保存（06_画面設計.md §16）。
 *
 * key-value のまま扱う。**型付けは Domain 側**（`domain/system-settings.ts`）で行う。
 * ここで型を知ると、設定が増えるたびに Infrastructure を触ることになる。
 */
export const systemSettingsRepository = {
  async loadAll(connection: Connection): Promise<Map<string, unknown>> {
    const rows = await connection.db
      .selectFrom('system_settings')
      .select(['key', 'value'])
      .execute();

    return new Map(rows.map((row) => [row.key, row.value]));
  },

  async put(connection: Connection, key: string, value: unknown): Promise<void> {
    await connection.db
      .insertInto('system_settings')
      .values({ key, value: JSON.stringify(value) })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }),
      )
      .execute();
  },
};
