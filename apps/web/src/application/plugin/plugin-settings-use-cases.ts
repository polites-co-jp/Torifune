import { defineUseCase } from '@/application/authorization/use-case';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { createPluginStore } from '@/plugin/store';
import { loadedPlugin, settingsOf } from '@/plugin/registry';

/**
 * Plugin の設定（06_画面設計.md §27, §38）。
 *
 * **Plugin は項目を宣言するだけで、保存は本体が行う。**
 * Plugin ごとにフォームと保存を書かせると、Secret の扱いが Plugin ごとに変わり、
 * どこかで平文が表に出る。
 *
 * `plugin.manage` を要求する。設定の中身には資格情報が入りうる。
 */

export interface SettingsFieldView {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly kind: 'text' | 'secret';
  readonly placeholder: string | null;
  /** `text` のみ現在値を返す。**`secret` は平文を返さない。** */
  readonly value: string | null;
  /** `secret` が設定済みか。 */
  readonly configured: boolean;
}

export interface PluginSettingsView {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly fields: readonly SettingsFieldView[];
}

function requireSettings(pluginId: string) {
  const loaded = loadedPlugin(pluginId);
  const settings = settingsOf(pluginId);
  if (loaded === null || settings === null) {
    throw new NotFoundError('Plugin の設定', pluginId);
  }
  return { loaded, settings };
}

export const getPluginSettings = defineUseCase<{ pluginId: string }, PluginSettingsView>({
  name: 'plugin.settings.get',
  permission: 'plugin.manage',
  handler: async (context, input) => {
    const { loaded, settings } = requireSettings(input.pluginId);
    const store = createPluginStore({ connection: context.connection, pluginId: input.pluginId });

    const fields: SettingsFieldView[] = [];
    for (const field of settings.fields) {
      if (field.kind === 'secret') {
        // **平文を返さない**（06_画面設計.md §38）。設定済みかだけを返す。
        fields.push({
          key: field.key,
          label: field.label,
          description: field.description ?? null,
          kind: 'secret',
          placeholder: field.placeholder ?? null,
          value: null,
          configured: await store.hasSecret(field.key),
        });
        continue;
      }

      const value = await store.get<string>(field.key);
      fields.push({
        key: field.key,
        label: field.label,
        description: field.description ?? null,
        kind: 'text',
        placeholder: field.placeholder ?? null,
        value: typeof value === 'string' ? value : null,
        configured: value !== null && value !== undefined,
      });
    }

    return { pluginId: input.pluginId, pluginName: loaded.manifest.name, fields };
  },
});

export interface SaveSettingsInput {
  readonly pluginId: string;
  readonly values: Readonly<Record<string, string>>;
}

export const savePluginSettings = defineUseCase<SaveSettingsInput, { saved: readonly string[] }>({
  name: 'plugin.settings.save',
  permission: 'plugin.manage',
  handler: async (context, input) => {
    const { settings } = requireSettings(input.pluginId);
    const byKey = new Map(settings.fields.map((field) => [field.key, field]));

    // **宣言していないキーは受け付けない。**
    // 受け付けると、フォームを細工して Plugin の任意のキーを書き換えられる。
    for (const key of Object.keys(input.values)) {
      if (!byKey.has(key)) {
        throw new ValidationError('Plugin の設定', key, '宣言されていない項目');
      }
    }

    if (settings.validate !== undefined) {
      const problems = await settings.validate(input.values);
      if (problems !== null && problems !== undefined && Object.keys(problems).length > 0) {
        const [field, detail] = Object.entries(problems)[0] as [string, string];
        throw new ValidationError('Plugin の設定', field, detail);
      }
    }

    const store = createPluginStore({ connection: context.connection, pluginId: input.pluginId });
    const saved: string[] = [];

    for (const [key, value] of Object.entries(input.values)) {
      const field = byKey.get(key);
      if (field === undefined) continue;

      if (field.kind === 'secret') {
        // 空欄は「変更しない」。空で上書きすると、
        // 保存し直すたびに設定済みの資格情報が消える。
        if (value === '') continue;
        await store.setSecret(key, value);
      } else {
        await store.set(key, value);
      }
      saved.push(key);
    }

    return { saved };
  },
});
