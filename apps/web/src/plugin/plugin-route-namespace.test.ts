import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_PLUGIN_IDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';

/**
 * Plugin ID と Core のルートの衝突（設計 027-plugin-http-api §2）。
 *
 * Next.js は静的セグメントを動的セグメント（`[id]`）より先に解決する。
 * `/api/v1/plugins/registry` のような静的ルートがあると、
 * `registry` を ID に持つ Plugin の管理経路がすべてそれに食われ、
 * **導入したあと有効化も削除もできなくなる。**
 */

const PLUGINS_API_DIR = join(import.meta.dirname, '..', 'app', 'api', 'v1', 'plugins');

function coreStaticSegments(): string[] {
  return (
    readdirSync(PLUGINS_API_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // `[id]` は動的セグメント。衝突の相手ではない。
      .filter((entry) => !entry.name.startsWith('['))
      .map((entry) => entry.name)
  );
}

function manifestWithId(id: string): unknown {
  return { id, name: 'Test', version: '1.0.0', apiVersion: 1, permissions: [] };
}

describe('Plugin ID と Core のルートの衝突', () => {
  /**
   * **これが本題。** 予約語の一覧と実際のルートが食い違ったまま気づかない、
   * という壊れ方を防ぐ。Core が静的ルートを足したらここが落ちる。
   */
  it('Core が /api/v1/plugins 直下で使う名前が、すべて予約語になっている', () => {
    for (const segment of coreStaticSegments()) {
      expect(
        RESERVED_PLUGIN_IDS.includes(segment),
        `/api/v1/plugins/${segment} がルートにあるのに RESERVED_PLUGIN_IDS へ入っていない。` +
          `この名前の Plugin を入れると、その Plugin を操作できなくなる`,
      ).toBe(true);
    }
  });

  /** 逆向き。使われていない名前を予約したままにしない。 */
  it('予約語に、もう存在しないルートが残っていない', () => {
    const segments = coreStaticSegments();

    for (const reserved of RESERVED_PLUGIN_IDS) {
      expect(
        segments.includes(reserved),
        `${reserved} を予約しているが /api/v1/plugins/${reserved} は無い`,
      ).toBe(true);
    }
  });

  it('予約語を ID にした Manifest は弾かれる', () => {
    for (const reserved of RESERVED_PLUGIN_IDS) {
      const result = validateManifest(manifestWithId(reserved));

      expect(result.ok, `${reserved} が通ってしまう`).toBe(false);
      if (!result.ok) {
        // 形式の誤りとして返すと、形は正しいので作者が直しようがない。
        const problem = result.problems.find((entry) => entry.field === 'id');
        expect(problem?.message).toContain('予約語');
      }
    }
  });

  it('予約語でない ID は通る', () => {
    const result = validateManifest(manifestWithId('seo-plugin'));

    expect(result.ok).toBe(true);
  });
});
