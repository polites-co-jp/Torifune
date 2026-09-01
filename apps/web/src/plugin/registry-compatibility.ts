import { isSupportedApiVersion } from '@torifune/plugin-api';
import { isNewerVersion } from '@/domain/plugin/version-order';
import { satisfiesVersion } from './dependencies';
import type { RegistryEntry } from './registry-client';

/**
 * Registry の項目を**導入する前に**判定する（03_プラグイン設計.md §15 §16 §17）。
 *
 * zip を落として展開してからでは遅い。Registry が宣言している情報だけで、
 * 「入れても動かない」ものを先に見分ける。
 *
 * **分からないことは分からないと言う。** 宣言が無いものを「合っている」と扱うと、
 * 入れてから壊れる。逆に「合っていない」と扱うと、正しい Plugin まで弾く。
 */

export type VersionVerdict = 'ok' | 'unsupported' | 'unknown';

export interface DependencyGap {
  readonly dependsOn: string;
  readonly required: string;
  readonly reason: 'missing' | 'disabled' | 'version_mismatch';
  /** 入っている版。入っていなければ null。 */
  readonly actual: string | null;
}

export interface RegistryCompatibility {
  readonly apiVersion: VersionVerdict;
  readonly torifuneVersion: VersionVerdict;
  /** 満たしていない依存。空なら足りている。 */
  readonly dependencies: readonly DependencyGap[];
  /** いま入っている版。未導入なら null。 */
  readonly installedVersion: string | null;
  /**
   * Registry のほうが新しいか（03_プラグイン設計.md §13）。
   *
   * **版を下げる更新は拒否される**（設計 §2.4）ので、
   * 古い版を「更新できる」と見せない。
   */
  readonly updateAvailable: boolean;
  /**
   * 導入させてよいか。
   *
   * **依存不足では止めない。** 依存 Plugin をあとから入れれば有効化できる。
   * 止めると、入れる順番によっては永久に入れられなくなる（設計 §3 で依存の自動解決を作らないと決めた）。
   * 止めるのは、導入しても Manifest の検証で必ず弾かれるものだけ。
   */
  readonly installable: boolean;
}

export interface InstalledPluginState {
  readonly version: string;
  readonly enabled: boolean;
}

export interface EvaluateOptions {
  /** 導入済み Plugin の状態。依存を満たすかの判定に使う。 */
  readonly installed: ReadonlyMap<string, InstalledPluginState>;
  /** この本体のバージョン。分からなければ null（判定しない）。 */
  readonly torifuneVersion?: string | null;
}

/**
 * この本体のバージョン。
 *
 * **まだ版を切っていない**（`package.json` は `0.0.0`）。
 * 0.0.0 を名乗って判定すると `^1.0.0` を要求する正しい Plugin まで弾いてしまうため、
 * 既定は「不明」とする。配布時に `TORIFUNE_VERSION` を与えれば判定に使う。
 */
export function currentTorifuneVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env['TORIFUNE_VERSION']?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

export function evaluateRegistryEntry(
  entry: RegistryEntry,
  options: EvaluateOptions,
): RegistryCompatibility {
  const apiVersion: VersionVerdict =
    entry.apiVersion === null
      ? 'unknown'
      : isSupportedApiVersion(entry.apiVersion)
        ? 'ok'
        : 'unsupported';

  const current = options.torifuneVersion ?? null;
  const torifuneVersion: VersionVerdict =
    entry.torifuneVersion === null || current === null
      ? 'unknown'
      : satisfiesVersion(current, entry.torifuneVersion)
        ? 'ok'
        : 'unsupported';

  const dependencies: DependencyGap[] = [];
  for (const [dependsOn, required] of Object.entries(entry.dependencies)) {
    const state = options.installed.get(dependsOn);

    if (state === undefined) {
      dependencies.push({ dependsOn, required, reason: 'missing', actual: null });
      continue;
    }
    if (!satisfiesVersion(state.version, required)) {
      dependencies.push({
        dependsOn,
        required,
        reason: 'version_mismatch',
        actual: state.version,
      });
      continue;
    }
    if (!state.enabled) {
      dependencies.push({ dependsOn, required, reason: 'disabled', actual: state.version });
    }
  }

  const self = options.installed.get(entry.id);

  return {
    apiVersion,
    torifuneVersion,
    dependencies,
    installedVersion: self?.version ?? null,
    updateAvailable: self !== undefined && isNewerVersion(entry.version, self.version),
    installable: apiVersion !== 'unsupported' && torifuneVersion !== 'unsupported',
  };
}
