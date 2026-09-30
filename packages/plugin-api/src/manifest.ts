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
  /**
   * 同梱する手順書（041 設計）。**並びが画面の並び。先頭が「最初に読む手順書」**で、
   * SNS 配信 Plugin では資格情報の手順書を先頭に置く（`/social` のヘルプボタンが先頭を開く）。
   * 形が誤っていれば本体は `help` を無いものとして扱う（Manifest そのものは拒否しない）。
   */
  readonly help?: readonly PluginHelpDoc[];
}

/** Plugin が同梱する手順書 1 本（041 設計 §6.1）。 */
export interface PluginHelpDoc {
  /** URL の一部（`/plugins/<plugin-id>/help/<id>`）。英小文字・数字・ハイフン、1〜64 文字、先頭は英小文字か数字。 */
  readonly id: string;
  /** 画面に出す題名。前後の空白を除いて 1〜80 文字。 */
  readonly title: string;
  /** Plugin のフォルダからの相対パス（`/` 区切り）。`.md` で終わる。 */
  readonly path: string;
}

/** 手順書の上限（041 設計 §6.1）。 */
export const PLUGIN_HELP_LIMITS = {
  maxDocs: 10,
  maxTitleLength: 80,
  maxPathLength: 200,
  /** ファイルの大きさの上限（バイト）。本体が読むときに確かめる。 */
  maxFileBytes: 262_144,
} as const;

const HELP_DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 手順書の path の形。`/` 区切りの相対パスで、**各区切りの先頭は `.` にできない**
 * （`..`・`.`・隠しファイル・隠しフォルダを拒む）。先頭の `/`、`\`、ドライブ名、
 * 空の区切り、URL はこの形に合わない。拡張子は小文字の `.md` だけ。
 *
 * `path.normalize` は使わない（OS で結果が変わる）。
 */
const HELP_DOC_PATH_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.md$/;

export const PLUGIN_EXTENSION_KINDS = [
  'ui',
  'events',
  'data',
  'authentication',
  'database',
  'social',
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
  | {
      readonly ok: true;
      readonly manifest: PluginManifest;
      /** Manifest を拒否しない誤り（041 設計 §9.2。いまは `help` だけ）。無ければキーごと省略。 */
      readonly warnings?: readonly ManifestProblem[];
    }
  | { readonly ok: false; readonly problems: readonly ManifestProblem[] };

/**
 * `help` の形を確かめる。誤りなら「どの規則に反したか」の固定の文を返す（値そのものは入れない）。
 * 正しい（または宣言なし）なら `null`。
 */
function helpProblem(help: unknown): string | null {
  if (!Array.isArray(help)) {
    return 'help は手順書の配列で指定する';
  }
  if (help.length > PLUGIN_HELP_LIMITS.maxDocs) {
    return `help は ${PLUGIN_HELP_LIMITS.maxDocs} 件まで`;
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, entry] of help.entries()) {
    const at = `help[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `${at} は { id, title, path } のオブジェクトで指定する`;
    }
    const item = entry as Record<string, unknown>;

    const id = item['id'];
    if (typeof id !== 'string' || !HELP_DOC_ID_PATTERN.test(id)) {
      return `${at}.id は英小文字・数字・ハイフンで 1〜64 文字。先頭は英小文字か数字`;
    }
    if (ids.has(id)) {
      return `${at}.id が他の手順書と重複している`;
    }
    ids.add(id);

    const title = item['title'];
    if (typeof title !== 'string') {
      return `${at}.title は文字列で指定する`;
    }
    const titleLength = Array.from(title.trim()).length;
    if (titleLength < 1 || titleLength > PLUGIN_HELP_LIMITS.maxTitleLength) {
      return `${at}.title は前後の空白を除いて 1〜${PLUGIN_HELP_LIMITS.maxTitleLength} 文字`;
    }

    const path = item['path'];
    if (
      typeof path !== 'string' ||
      path.length < 1 ||
      path.length > PLUGIN_HELP_LIMITS.maxPathLength ||
      !HELP_DOC_PATH_PATTERN.test(path)
    ) {
      return `${at}.path は help/credentials.md のような / 区切りの相対パス（1〜${PLUGIN_HELP_LIMITS.maxPathLength} 文字）で .md で終わる。各区切りの先頭に . を置けない`;
    }
    if (paths.has(path)) {
      return `${at}.path が他の手順書と重複している`;
    }
    paths.add(path);
  }
  return null;
}

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
    // `help` の誤りは混ぜない（041 より前と同じ problems を返す）。
    return { ok: false, problems };
  }

  // **`help` の誤りは Manifest を拒否しない**（041 設計 §9.2）。041 より前は未知の項目として
  // どんな値でも通っていたので、拒否すると本体の更新だけで既存の Plugin が読み込めなくなる。
  // 誤りなら `help` 全体を無いものとして扱い（全部か無しか）、警告を 1 件返す。
  if (raw['help'] !== undefined) {
    const message = helpProblem(raw['help']);
    if (message !== null) {
      const { help: _dropped, ...rest } = raw;
      return {
        ok: true,
        manifest: rest as unknown as PluginManifest,
        warnings: [{ field: 'help', message }],
      };
    }
  }

  return { ok: true, manifest: raw as unknown as PluginManifest };
}
