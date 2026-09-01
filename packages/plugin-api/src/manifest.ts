import { isSupportedApiVersion } from './version';

/**
 * Plugin Manifest（03_プラグイン設計.md §11）。
 *
 * ファイル名は `plugin.json`。
 */

export interface PluginManifest {
  /** 一意な識別子。Route・Database Namespace・設定のキーにも使う（同 §16）。 */
  readonly id: string;
  readonly name: string;
  /** Semantic Versioning。 */
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
  /** 対応する Plugin API のバージョン。 */
  readonly apiVersion: number;
  /** 要求する Permission（同 §20.2）。宣言していない操作は失敗する。 */
  readonly permissions?: readonly string[];
  /** 依存する Plugin（同 §17）。 */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** 提供する拡張点の種類。 */
  readonly extensions?: readonly PluginExtensionKind[];
}

export const PLUGIN_EXTENSION_KINDS = [
  'ui',
  'events',
  'data',
  'authentication',
  'database',
] as const;

export type PluginExtensionKind = (typeof PLUGIN_EXTENSION_KINDS)[number];

/**
 * Plugin ID の形式。
 *
 * URL の一部（`/plugins/<id>/`）とデータの名前空間になるため、
 * 扱いにくい文字を許さない。
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Core が `/api/v1/plugins/` の直下で使っている名前。**Plugin ID にできない。**
 *
 * Next.js は静的なセグメントを動的なセグメント（`[id]`）より先に解決する。
 * そのため、ここにある名前を ID に持つ Plugin を入れると、
 * その Plugin に対する有効化・無効化・設定・削除の経路が
 * **すべて Core のルートに食われ、導入後に操作できなくなる。**
 *
 * 導入してから壊れるのではなく、導入しようとした時点で断る。
 *
 * **Core が `app/api/v1/plugins/` 直下へ静的ルートを足したら、ここへも足す。**
 * 対応が破れていないことは `plugin-route-namespace.test.ts` が固定している。
 */
export const RESERVED_PLUGIN_IDS: readonly string[] = ['registry', 'package', 'operations'];

/** Semantic Versioning（プレリリース・ビルドメタデータを含む）。 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isValidPluginId(value: string): boolean {
  return PLUGIN_ID_PATTERN.test(value) && !RESERVED_PLUGIN_IDS.includes(value);
}

export function isValidPluginVersion(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export interface ManifestProblem {
  readonly field: string;
  readonly message: string;
}

export type ManifestValidation =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly problems: readonly ManifestProblem[] };

/**
 * Manifest を検証する。
 *
 * **未知の項目があっても拒否しない。** 拒否すると、新しい項目を足した
 * Plugin が古い本体で一切動かなくなる（前方互換性）。
 *
 * `knownPermissions` を渡すと、宣言された Permission の実在も確かめる。
 * ただし `<plugin-id>.…` は Plugin が自分で定義するものとして許す。
 */
export function validateManifest(
  input: unknown,
  options: { readonly knownPermissions?: readonly string[] } = {},
): ManifestValidation {
  const problems: ManifestProblem[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: [{ field: '_', message: 'Manifest がオブジェクトではない' }] };
  }

  const raw = input as Record<string, unknown>;

  const id = raw['id'];
  if (typeof id === 'string' && RESERVED_PLUGIN_IDS.includes(id)) {
    // **形式の話にしない。** 形は正しいのに弾かれるので、
    // 「英小文字・数字・ハイフンで」と返されても作者は直しようがない。
    problems.push({
      field: 'id',
      message: `\`${id}\` は Core が使っている名前のため Plugin ID にできない（予約語: ${RESERVED_PLUGIN_IDS.join(', ')}）`,
    });
  } else if (typeof id !== 'string' || !isValidPluginId(id)) {
    problems.push({
      field: 'id',
      message: '英小文字・数字・ハイフンで、2〜64文字。先頭は英小文字',
    });
  }

  const name = raw['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push({ field: 'name', message: '必須' });
  }

  const version = raw['version'];
  if (typeof version !== 'string' || !isValidPluginVersion(version)) {
    problems.push({ field: 'version', message: 'Semantic Versioning で指定する' });
  }

  const apiVersion = raw['apiVersion'];
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    problems.push({ field: 'apiVersion', message: '整数で指定する' });
  } else if (!isSupportedApiVersion(apiVersion)) {
    problems.push({
      field: 'apiVersion',
      message: `この Torifune が対応していない Plugin API バージョン: ${apiVersion}`,
    });
  }

  const permissions = raw['permissions'];
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== 'string')) {
      problems.push({ field: 'permissions', message: '文字列の配列で指定する' });
    } else if (options.knownPermissions !== undefined) {
      for (const permission of permissions as string[]) {
        if (options.knownPermissions.includes(permission)) {
          continue;
        }
        // **自分の名前空間なら新しく定義してよい。**
        // 本体の Permission しか宣言できないと、Plugin は
        // 自分の機能に対する権限を作れない（03_プラグイン設計.md §20.2）。
        if (typeof id === 'string' && permission.startsWith(`${id}.`)) {
          continue;
        }
        problems.push({
          field: 'permissions',
          message: `未定義の Permission: ${permission}（本体の Permission か ${
            typeof id === 'string' ? id : '<plugin-id>'
          }.… のいずれかにする）`,
        });
      }
    }
  }

  const dependencies = raw['dependencies'];
  if (dependencies !== undefined) {
    if (
      typeof dependencies !== 'object' ||
      dependencies === null ||
      Array.isArray(dependencies) ||
      Object.values(dependencies).some((v) => typeof v !== 'string')
    ) {
      problems.push({ field: 'dependencies', message: '"plugin-id": "バージョン範囲" の形' });
    }
  }

  const extensions = raw['extensions'];
  if (extensions !== undefined) {
    if (
      !Array.isArray(extensions) ||
      extensions.some(
        (e) => typeof e !== 'string' || !(PLUGIN_EXTENSION_KINDS as readonly string[]).includes(e),
      )
    ) {
      problems.push({
        field: 'extensions',
        message: `次のいずれか: ${PLUGIN_EXTENSION_KINDS.join(', ')}`,
      });
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return { ok: true, manifest: raw as unknown as PluginManifest };
}
