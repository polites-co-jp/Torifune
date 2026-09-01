import { describe, expect, it } from 'vitest';
import {
  currentTorifuneVersion,
  evaluateRegistryEntry,
  type InstalledPluginState,
} from './registry-compatibility';
import type { RegistryEntry } from './registry-client';

/**
 * Registry の項目を**導入する前に**判定する（03_プラグイン設計.md §15 §16 §17）。
 *
 * zip を落として展開してからでは遅い。Registry が宣言している情報だけで、
 * 「入れても動かない」ものを先に見分ける。
 */

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'sample-plugin',
    name: 'サンプル',
    version: '1.0.0',
    description: null,
    downloadUrl: 'https://example.com/sample-1.0.0.zip',
    sha256: 'abc123',
    signature: 'c2ln',
    publisher: 'example.com',
    apiVersion: 1,
    dependencies: {},
    torifuneVersion: null,
    updatedAt: null,
    permissions: null,
    ...overrides,
  };
}

function installed(
  entries: Readonly<Record<string, InstalledPluginState>> = {},
): ReadonlyMap<string, InstalledPluginState> {
  return new Map(Object.entries(entries));
}

describe('Plugin API Version', () => {
  it('対応していれば ok', () => {
    const result = evaluateRegistryEntry(entry({ apiVersion: 1 }), { installed: installed() });

    expect(result.apiVersion).toBe('ok');
    expect(result.installable).toBe(true);
  });

  /** 導入しても Manifest の検証で弾かれる。押させてから失敗させない。 */
  it('対応していなければ導入させない', () => {
    const result = evaluateRegistryEntry(entry({ apiVersion: 99 }), { installed: installed() });

    expect(result.apiVersion).toBe('unsupported');
    expect(result.installable).toBe(false);
  });

  it('宣言が無ければ不明。それだけでは止めない', () => {
    const result = evaluateRegistryEntry(entry({ apiVersion: null }), { installed: installed() });

    expect(result.apiVersion).toBe('unknown');
    expect(result.installable).toBe(true);
  });
});

describe('依存関係', () => {
  it('満たしていれば何も出ない', () => {
    const result = evaluateRegistryEntry(entry({ dependencies: { 'base-plugin': '^1.0.0' } }), {
      installed: installed({ 'base-plugin': { version: '1.2.0', enabled: true } }),
    });

    expect(result.dependencies).toEqual([]);
  });

  it('入っていなければ missing として出す', () => {
    const result = evaluateRegistryEntry(entry({ dependencies: { 'base-plugin': '^1.0.0' } }), {
      installed: installed(),
    });

    expect(result.dependencies).toEqual([
      { dependsOn: 'base-plugin', required: '^1.0.0', reason: 'missing', actual: null },
    ]);
  });

  it('入っているが無効なら disabled として出す', () => {
    const result = evaluateRegistryEntry(entry({ dependencies: { 'base-plugin': '^1.0.0' } }), {
      installed: installed({ 'base-plugin': { version: '1.2.0', enabled: false } }),
    });

    expect(result.dependencies[0]?.reason).toBe('disabled');
  });

  it('版が範囲に入らなければ version_mismatch として出す', () => {
    const result = evaluateRegistryEntry(entry({ dependencies: { 'base-plugin': '^2.0.0' } }), {
      installed: installed({ 'base-plugin': { version: '1.2.0', enabled: true } }),
    });

    expect(result.dependencies[0]).toEqual({
      dependsOn: 'base-plugin',
      required: '^2.0.0',
      reason: 'version_mismatch',
      actual: '1.2.0',
    });
  });

  /**
   * **依存が足りなくても導入は止めない。**
   * 依存 Plugin をあとから入れれば有効化できる。止めると順番の問題で入れられなくなる。
   * 止めるのではなく、有効化できないことを先に伝える（設計 §3「依存の自動解決を作らない」）。
   */
  it('依存が足りなくても導入自体は許す', () => {
    const result = evaluateRegistryEntry(entry({ dependencies: { 'base-plugin': '^1.0.0' } }), {
      installed: installed(),
    });

    expect(result.installable).toBe(true);
  });
});

describe('対応 Torifune Version', () => {
  it('本体の版が分からなければ判定しない', () => {
    const result = evaluateRegistryEntry(entry({ torifuneVersion: '^1.0.0' }), {
      installed: installed(),
      torifuneVersion: null,
    });

    expect(result.torifuneVersion).toBe('unknown');
    expect(result.installable).toBe(true);
  });

  it('範囲に入っていれば ok', () => {
    const result = evaluateRegistryEntry(entry({ torifuneVersion: '^1.0.0' }), {
      installed: installed(),
      torifuneVersion: '1.4.2',
    });

    expect(result.torifuneVersion).toBe('ok');
  });

  it('範囲から外れていれば導入させない', () => {
    const result = evaluateRegistryEntry(entry({ torifuneVersion: '^2.0.0' }), {
      installed: installed(),
      torifuneVersion: '1.4.2',
    });

    expect(result.torifuneVersion).toBe('unsupported');
    expect(result.installable).toBe(false);
  });
});

/**
 * 更新の導線（03_プラグイン設計.md §13）。
 *
 * **新しい版が出ていることを、人が気づけるようにする。**
 * zip を上げ直す経路しか無いと、更新があること自体に気づけない。
 */
describe('導入済みとの比較', () => {
  it('未導入なら installedVersion は null', () => {
    const result = evaluateRegistryEntry(entry({ version: '1.0.0' }), { installed: installed() });

    expect(result.installedVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it('Registry の版が新しければ更新できると答える', () => {
    const result = evaluateRegistryEntry(entry({ version: '1.2.0' }), {
      installed: installed({ 'sample-plugin': { version: '1.0.0', enabled: true } }),
    });

    expect(result.installedVersion).toBe('1.0.0');
    expect(result.updateAvailable).toBe(true);
  });

  it('同じ版なら更新できると言わない', () => {
    const result = evaluateRegistryEntry(entry({ version: '1.0.0' }), {
      installed: installed({ 'sample-plugin': { version: '1.0.0', enabled: true } }),
    });

    expect(result.updateAvailable).toBe(false);
  });

  /** 版を下げる更新は拒否される（設計 §2.4）。押せる形にしない。 */
  it('Registry の版のほうが古ければ更新できると言わない', () => {
    const result = evaluateRegistryEntry(entry({ version: '0.9.0' }), {
      installed: installed({ 'sample-plugin': { version: '1.0.0', enabled: true } }),
    });

    expect(result.updateAvailable).toBe(false);
  });
});

describe('currentTorifuneVersion', () => {
  /**
   * 本体はまだ版を切っていない（`package.json` は 0.0.0）。
   * **0.0.0 を名乗って判定すると、正しい Plugin まで弾く。** 分からないなら分からないと言う。
   */
  it('未設定なら null', () => {
    expect(currentTorifuneVersion({})).toBeNull();
    expect(currentTorifuneVersion({ TORIFUNE_VERSION: '  ' })).toBeNull();
  });

  it('設定されていればそれを使う', () => {
    expect(currentTorifuneVersion({ TORIFUNE_VERSION: '1.4.2' })).toBe('1.4.2');
  });
});
