import type { PluginManifest } from '@torifune/plugin-api';

/**
 * Plugin の依存関係の検証（03_プラグイン設計.md §17）。
 *
 * **依存を満たさない Plugin は有効化しない。**
 * 有効化してから壊れるより、有効化を断るほうが原因が分かりやすい。
 */

export type DependencyProblem =
  | { readonly kind: 'missing'; readonly pluginId: string; readonly dependsOn: string }
  | { readonly kind: 'disabled'; readonly pluginId: string; readonly dependsOn: string }
  | {
      readonly kind: 'version_mismatch';
      readonly pluginId: string;
      readonly dependsOn: string;
      readonly required: string;
      readonly actual: string;
    }
  | { readonly kind: 'cycle'; readonly pluginIds: readonly string[] };

export interface DependencyCandidate {
  readonly manifest: PluginManifest;
  readonly enabled: boolean;
}

/**
 * バージョン範囲の判定。
 *
 * `^1.2.3` / `~1.2.3` / `1.2.3` / `*` を扱う。
 * **完全な semver 実装ではない。** 外部ライブラリを増やす前に、
 * 実際に必要になった記法だけを足す。
 */
export function satisfiesVersion(actual: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') {
    return true;
  }

  const parse = (value: string): [number, number, number] | null => {
    // プレリリース・ビルドメタデータは比較から落とす。
    const core = value.split('-')[0]?.split('+')[0] ?? '';
    const parts = core.split('.').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
      return null;
    }
    return [parts[0] as number, parts[1] as number, parts[2] as number];
  };

  const actualParts = parse(actual);
  if (actualParts === null) {
    return false;
  }

  const operator = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : '=';
  const requiredParts = parse(operator === '=' ? trimmed : trimmed.slice(1));
  if (requiredParts === null) {
    return false;
  }

  const [aMajor, aMinor, aPatch] = actualParts;
  const [rMajor, rMinor, rPatch] = requiredParts;

  const atLeast =
    aMajor > rMajor ||
    (aMajor === rMajor && (aMinor > rMinor || (aMinor === rMinor && aPatch >= rPatch)));

  if (operator === '=') {
    return aMajor === rMajor && aMinor === rMinor && aPatch === rPatch;
  }
  if (operator === '^') {
    // 0.x は破壊的変更が起きやすいため、マイナーまで固定する。
    if (rMajor === 0) {
      return aMajor === 0 && aMinor === rMinor && atLeast;
    }
    return aMajor === rMajor && atLeast;
  }
  // ~ はパッチのみ許す。
  return aMajor === rMajor && aMinor === rMinor && atLeast;
}

/**
 * 循環依存を検出する。
 *
 * 検出しないと、有効化の連鎖が終わらない。
 */
export function findDependencyCycle(
  candidates: ReadonlyMap<string, DependencyCandidate>,
): readonly string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function walk(id: string): readonly string[] | null {
    if (visiting.has(id)) {
      // 循環の始点から現在までを返す。
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) {
      return null;
    }

    visiting.add(id);
    path.push(id);

    const dependencies = candidates.get(id)?.manifest.dependencies ?? {};
    for (const dependsOn of Object.keys(dependencies)) {
      if (!candidates.has(dependsOn)) {
        continue;
      }
      const cycle = walk(dependsOn);
      if (cycle !== null) {
        return cycle;
      }
    }

    visiting.delete(id);
    path.pop();
    visited.add(id);
    return null;
  }

  for (const id of candidates.keys()) {
    const cycle = walk(id);
    if (cycle !== null) {
      return cycle;
    }
  }

  return null;
}

/**
 * ある Plugin を有効化してよいかを判定する。
 *
 * `candidates` には**導入済みの Plugin だけ**を入れる。
 */
export function checkDependencies(
  pluginId: string,
  candidates: ReadonlyMap<string, DependencyCandidate>,
): readonly DependencyProblem[] {
  const problems: DependencyProblem[] = [];

  const cycle = findDependencyCycle(candidates);
  if (cycle !== null && cycle.includes(pluginId)) {
    problems.push({ kind: 'cycle', pluginIds: cycle });
    // 循環がある状態で依存を辿ると終わらない。ここで止める。
    return problems;
  }

  const target = candidates.get(pluginId);
  if (target === undefined) {
    return problems;
  }

  for (const [dependsOn, range] of Object.entries(target.manifest.dependencies ?? {})) {
    const dependency = candidates.get(dependsOn);

    if (dependency === undefined) {
      problems.push({ kind: 'missing', pluginId, dependsOn });
      continue;
    }
    if (!dependency.enabled) {
      problems.push({ kind: 'disabled', pluginId, dependsOn });
      continue;
    }
    if (!satisfiesVersion(dependency.manifest.version, range)) {
      problems.push({
        kind: 'version_mismatch',
        pluginId,
        dependsOn,
        required: range,
        actual: dependency.manifest.version,
      });
    }
  }

  return problems;
}

/**
 * ある Plugin に依存している Plugin を挙げる。
 *
 * 無効化するとき、依存元も無効化する必要がある。
 * 依存先が消えたまま動くと、Plugin が実行時に壊れる。
 */
export function dependentsOf(
  pluginId: string,
  candidates: ReadonlyMap<string, DependencyCandidate>,
): readonly string[] {
  const dependents: string[] = [];

  for (const [id, candidate] of candidates) {
    if (id === pluginId) {
      continue;
    }
    if (Object.keys(candidate.manifest.dependencies ?? {}).includes(pluginId)) {
      dependents.push(id);
    }
  }

  return dependents.sort();
}
