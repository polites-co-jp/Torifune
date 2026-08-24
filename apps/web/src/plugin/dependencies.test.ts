import type { PluginManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  checkDependencies,
  dependentsOf,
  findDependencyCycle,
  satisfiesVersion,
  type DependencyCandidate,
} from './dependencies';

function manifest(
  id: string,
  version: string,
  dependencies?: Record<string, string>,
): PluginManifest {
  return {
    id,
    name: id,
    version,
    apiVersion: 1,
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

function candidates(
  ...entries: readonly [PluginManifest, boolean][]
): Map<string, DependencyCandidate> {
  return new Map(entries.map(([m, enabled]) => [m.id, { manifest: m, enabled }]));
}

describe('satisfiesVersion', () => {
  it('* は何でも満たす', () => {
    expect(satisfiesVersion('1.2.3', '*')).toBe(true);
    expect(satisfiesVersion('0.0.1', '')).toBe(true);
  });

  it('完全一致', () => {
    expect(satisfiesVersion('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesVersion('1.2.4', '1.2.3')).toBe(false);
  });

  it('^ はメジャーを固定し、それ以上を許す', () => {
    expect(satisfiesVersion('1.2.3', '^1.2.0')).toBe(true);
    expect(satisfiesVersion('1.9.9', '^1.2.0')).toBe(true);
    expect(satisfiesVersion('1.1.0', '^1.2.0')).toBe(false);
    expect(satisfiesVersion('2.0.0', '^1.2.0')).toBe(false);
  });

  it('^0.x はマイナーまで固定する', () => {
    // 0.x は破壊的変更が起きやすい。
    expect(satisfiesVersion('0.2.5', '^0.2.0')).toBe(true);
    expect(satisfiesVersion('0.3.0', '^0.2.0')).toBe(false);
  });

  it('~ はパッチのみ許す', () => {
    expect(satisfiesVersion('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesVersion('1.3.0', '~1.2.0')).toBe(false);
  });

  it('プレリリースは比較から落とす', () => {
    expect(satisfiesVersion('1.2.3-beta.1', '^1.2.0')).toBe(true);
  });

  it('形式が不正なら満たさない', () => {
    expect(satisfiesVersion('latest', '^1.0.0')).toBe(false);
    expect(satisfiesVersion('1.2.3', '^bad')).toBe(false);
  });
});

describe('findDependencyCycle', () => {
  it('循環が無ければ null', () => {
    const map = candidates(
      [manifest('a', '1.0.0', { b: '*' }), true],
      [manifest('b', '1.0.0'), true],
    );

    expect(findDependencyCycle(map)).toBeNull();
  });

  it('直接の循環を検出する', () => {
    const map = candidates(
      [manifest('a', '1.0.0', { b: '*' }), true],
      [manifest('b', '1.0.0', { a: '*' }), true],
    );

    const cycle = findDependencyCycle(map);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('間接の循環を検出する', () => {
    const map = candidates(
      [manifest('a', '1.0.0', { b: '*' }), true],
      [manifest('b', '1.0.0', { c: '*' }), true],
      [manifest('c', '1.0.0', { a: '*' }), true],
    );

    expect(findDependencyCycle(map)).not.toBeNull();
  });

  it('自己参照を検出する', () => {
    const map = candidates([manifest('a', '1.0.0', { a: '*' }), true]);

    expect(findDependencyCycle(map)).not.toBeNull();
  });

  it('導入されていない依存は辿らない', () => {
    const map = candidates([manifest('a', '1.0.0', { missing: '*' }), true]);

    expect(findDependencyCycle(map)).toBeNull();
  });
});

describe('checkDependencies', () => {
  it('依存が無ければ問題なし', () => {
    const map = candidates([manifest('a', '1.0.0'), true]);

    expect(checkDependencies('a', map)).toEqual([]);
  });

  it('依存が導入されていなければ missing', () => {
    const map = candidates([manifest('a', '1.0.0', { b: '*' }), false]);

    expect(checkDependencies('a', map)).toEqual([
      { kind: 'missing', pluginId: 'a', dependsOn: 'b' },
    ]);
  });

  it('依存が無効なら disabled', () => {
    const map = candidates(
      [manifest('a', '1.0.0', { b: '*' }), false],
      [manifest('b', '1.0.0'), false],
    );

    expect(checkDependencies('a', map)).toEqual([
      { kind: 'disabled', pluginId: 'a', dependsOn: 'b' },
    ]);
  });

  it('バージョンが範囲外なら version_mismatch', () => {
    const map = candidates(
      [manifest('a', '1.0.0', { b: '^2.0.0' }), false],
      [manifest('b', '1.0.0'), true],
    );

    expect(checkDependencies('a', map)).toEqual([
      {
        kind: 'version_mismatch',
        pluginId: 'a',
        dependsOn: 'b',
        required: '^2.0.0',
        actual: '1.0.0',
      },
    ]);
  });

  it('依存を満たせば問題なし', () => {
    const map = candidates(
      [manifest('a', '1.0.0', { b: '^1.0.0' }), false],
      [manifest('b', '1.2.0'), true],
    );

    expect(checkDependencies('a', map)).toEqual([]);
  });

  it('循環があれば cycle を返し、依存の検査を止める', () => {
    // 循環がある状態で依存を辿ると終わらない。
    const map = candidates(
      [manifest('a', '1.0.0', { b: '*' }), true],
      [manifest('b', '1.0.0', { a: '*' }), true],
    );

    const problems = checkDependencies('a', map);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('cycle');
  });

  it('複数の問題をまとめて返す', () => {
    const map = candidates([manifest('a', '1.0.0', { b: '*', c: '*' }), false]);

    expect(checkDependencies('a', map)).toHaveLength(2);
  });
});

describe('dependentsOf', () => {
  it('依存している Plugin を挙げる', () => {
    const map = candidates(
      [manifest('a', '1.0.0'), true],
      [manifest('b', '1.0.0', { a: '*' }), true],
      [manifest('c', '1.0.0', { a: '*' }), true],
      [manifest('d', '1.0.0'), true],
    );

    expect(dependentsOf('a', map)).toEqual(['b', 'c']);
  });

  it('誰も依存していなければ空', () => {
    const map = candidates([manifest('a', '1.0.0'), true], [manifest('b', '1.0.0'), true]);

    expect(dependentsOf('a', map)).toEqual([]);
  });

  it('自分自身を含めない', () => {
    const map = candidates([manifest('a', '1.0.0', { a: '*' }), true]);

    expect(dependentsOf('a', map)).toEqual([]);
  });
});
