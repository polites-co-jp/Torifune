import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_EVENTS } from './events';
import * as publicApi from './index';
import {
  isValidPluginId,
  isValidPluginVersion,
  PLUGIN_EXTENSION_KINDS,
  validateManifest,
} from './manifest';
import { isValidStoreKey, MAX_VALUE_BYTES } from './store';
import { isSupportedApiVersion, PLUGIN_API_VERSION, SUPPORTED_API_VERSIONS } from './version';

const SRC_DIR = import.meta.dirname;

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'seo-plugin',
    name: 'SEO Plugin',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    ...overrides,
  };
}

describe('パッケージの境界', () => {
  it('本体（apps/web）を import していない', () => {
    // 依存の向きが逆転すると、Plugin 作者が本体の内部実装に縛られる。
    for (const file of readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      expect(source, `${file}`).not.toMatch(/from\s+['"]@torifune\/web/);
      expect(source, `${file}`).not.toMatch(/from\s+['"].*apps\/web/);
    }
  });

  it('DB 製品やフレームワークを import していない', () => {
    // 本体が使うライブラリの変更が、Plugin API の破壊的変更にならないように。
    for (const file of readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'))) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      for (const forbidden of ['pg', 'kysely', 'next', 'react', 'zod']) {
        expect(source, `${file} が ${forbidden} を import している`).not.toMatch(
          new RegExp(`from\\s+['"]${forbidden}(/|['"])`),
        );
      }
    }
  });

  it('公開する入口から主要な型と値が取れる', () => {
    expect(publicApi.PLUGIN_API_VERSION).toBe(1);
    expect(publicApi.validateManifest).toBeTypeOf('function');
    expect(publicApi.CORE_EXTENSION_POINTS.length).toBeGreaterThan(0);
    expect(publicApi.CORE_EVENTS.length).toBeGreaterThan(0);
    expect(publicApi.PluginStoreError).toBeTypeOf('function');
    expect(publicApi.PluginPermissionError).toBeTypeOf('function');
  });
});

describe('Plugin API Version', () => {
  it('定数として公開されている', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it('対応バージョンを判定できる', () => {
    expect(isSupportedApiVersion(1)).toBe(true);
    expect(isSupportedApiVersion(99)).toBe(false);
  });
});

describe('isValidPluginId', () => {
  it('英小文字とハイフンを受け入れる', () => {
    expect(isValidPluginId('seo-plugin')).toBe(true);
    expect(isValidPluginId('x2')).toBe(true);
  });

  it('大文字を拒否する', () => {
    expect(isValidPluginId('SeoPlugin')).toBe(false);
  });

  it('空白を拒否する', () => {
    expect(isValidPluginId('seo plugin')).toBe(false);
  });

  it('ドットを拒否する', () => {
    // URL とデータの名前空間になるため、扱いにくい文字を許さない。
    expect(isValidPluginId('example.plugin')).toBe(false);
  });

  it('パス区切りを拒否する', () => {
    expect(isValidPluginId('../evil')).toBe(false);
    expect(isValidPluginId('a/b')).toBe(false);
  });

  it('1文字を拒否する', () => {
    expect(isValidPluginId('a')).toBe(false);
  });

  it('先頭が数字の ID を拒否する', () => {
    expect(isValidPluginId('1plugin')).toBe(false);
  });

  it('長すぎる ID を拒否する', () => {
    expect(isValidPluginId('a'.repeat(65))).toBe(false);
  });
});

describe('isValidPluginVersion', () => {
  it('Semantic Versioning を受け入れる', () => {
    expect(isValidPluginVersion('1.0.0')).toBe(true);
    expect(isValidPluginVersion('0.1.2')).toBe(true);
    expect(isValidPluginVersion('1.0.0-beta.1')).toBe(true);
    expect(isValidPluginVersion('1.0.0+build.5')).toBe(true);
  });

  it('形式外を拒否する', () => {
    expect(isValidPluginVersion('1.0')).toBe(false);
    expect(isValidPluginVersion('v1.0.0')).toBe(false);
    expect(isValidPluginVersion('latest')).toBe(false);
    expect(isValidPluginVersion('01.0.0')).toBe(false);
  });
});

describe('validateManifest', () => {
  it('妥当な Manifest を受け入れる', () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
  });

  it('オブジェクトでなければ拒否する', () => {
    expect(validateManifest('not an object').ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });

  it('id が不正なら拒否する', () => {
    const result = validateManifest(validManifest({ id: 'Bad Id' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('id');
  });

  it('name が無ければ拒否する', () => {
    const result = validateManifest(validManifest({ name: '  ' }));
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('name');
  });

  it('version が Semantic Versioning でなければ拒否する', () => {
    const result = validateManifest(validManifest({ version: '1.0' }));
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('version');
  });

  it('apiVersion が対応外なら拒否する', () => {
    const result = validateManifest(validManifest({ apiVersion: 99 }));
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('apiVersion');
  });

  it('必須項目が欠けていたら拒否する', () => {
    const result = validateManifest({ id: 'seo-plugin' });
    expect(result.ok).toBe(false);
  });

  it('未知の項目があっても拒否しない', () => {
    // 拒否すると、新しい項目を足した Plugin が古い本体で一切動かなくなる。
    const result = validateManifest(validManifest({ futureField: 'x' }));
    expect(result.ok).toBe(true);
  });

  it('依存 Plugin を宣言できる', () => {
    const result = validateManifest(validManifest({ dependencies: { 'other-plugin': '^1.0.0' } }));
    expect(result.ok).toBe(true);
  });

  it('依存の形式が不正なら拒否する', () => {
    const result = validateManifest(validManifest({ dependencies: ['other-plugin'] }));
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('dependencies');
  });

  it('Permission を宣言できる', () => {
    const result = validateManifest(validManifest({ permissions: ['site.read'] }));
    expect(result.ok).toBe(true);
  });

  it('未定義の Permission を宣言していたら拒否する', () => {
    const result = validateManifest(validManifest({ permissions: ['site.read', 'nope.read'] }), {
      knownPermissions: ['site.read'],
    });
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('permissions');
  });

  it('自分の名前空間の Permission は新しく定義できる', () => {
    // 本体の Permission しか宣言できないと、
    // Plugin は自分の機能に対する権限を作れない。
    const result = validateManifest(
      validManifest({ permissions: ['site.read', 'seo-plugin.report.read'] }),
      { knownPermissions: ['site.read'] },
    );
    expect(result.ok).toBe(true);
  });

  it('他の Plugin の名前空間は名乗れない', () => {
    // 名乗れると、他の Plugin の権限を横取りできる。
    const result = validateManifest(validManifest({ permissions: ['other-plugin.report.read'] }), {
      knownPermissions: ['site.read'],
    });
    expect(!result.ok && result.problems.map((p) => p.field)).toContain('permissions');
  });

  it('extensions の値を検証する', () => {
    expect(validateManifest(validManifest({ extensions: ['ui', 'events'] })).ok).toBe(true);
    expect(validateManifest(validManifest({ extensions: ['unknown'] })).ok).toBe(false);
  });

  it('extensions の候補が公開されている', () => {
    expect(PLUGIN_EXTENSION_KINDS).toContain('ui');
    expect(PLUGIN_EXTENSION_KINDS).toContain('authentication');
    expect(PLUGIN_EXTENSION_KINDS).toContain('database');
  });

  it('複数の問題をまとめて返す', () => {
    const result = validateManifest({ id: 'BAD', version: 'nope' });
    expect(!result.ok && result.problems.length).toBeGreaterThan(2);
  });
});

describe('isValidStoreKey', () => {
  it('階層つきのキーを受け入れる', () => {
    expect(isValidStoreKey('oauth/access-token')).toBe(true);
    expect(isValidStoreKey('settings.theme')).toBe(true);
  });

  it('大文字と空白を拒否する', () => {
    expect(isValidStoreKey('OAuth')).toBe(false);
    expect(isValidStoreKey('a b')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(isValidStoreKey('')).toBe(false);
  });

  it('長すぎるキーを拒否する', () => {
    expect(isValidStoreKey('a'.repeat(129))).toBe(false);
  });

  it('値の上限が公開されている', () => {
    expect(MAX_VALUE_BYTES).toBeGreaterThan(0);
  });
});

/**
 * SNS 配信の拡張点（035-social-publishing 設計 §9.1 / §9.2 / §9.3 / §9.6）。
 *
 * 受け入れ条件 #18。**追加のみで、版は上げない。**
 */
describe('#18 SNS 配信（social）の公開契約', () => {
  it('#18 extensions に social を宣言した Manifest を受け入れる', () => {
    expect(validateManifest(validManifest({ extensions: ['social'] })).ok).toBe(true);
  });

  it('#18 PLUGIN_EXTENSION_KINDS に social がある', () => {
    expect(PLUGIN_EXTENSION_KINDS).toContain('social');
  });

  it('#18 既存の拡張点の種類が消えていない', () => {
    // 消すと、その拡張点を宣言している既存の Plugin が検証で弾かれる。
    for (const kind of ['ui', 'events', 'data', 'authentication', 'database']) {
      expect(PLUGIN_EXTENSION_KINDS).toContain(kind);
    }
  });

  it('#18 PLUGIN_API_VERSION は 1 のまま', () => {
    // 追加だけなので破壊的変更ではない（010-plugin-api 設計 §9）。
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it('#18 SUPPORTED_API_VERSIONS が変わっていない', () => {
    expect([...SUPPORTED_API_VERSIONS]).toEqual([1]);
  });

  it('#18 CORE_EVENTS に social.post.failed がある', () => {
    // 自動配信が入ると失敗が人手を介さず起きる。拾えないと運用者が気づけない。
    expect(CORE_EVENTS).toContain('social.post.failed');
  });

  it('#18 既存の Core イベント名が消えていない', () => {
    for (const name of ['social.post.created', 'social.post.published', 'analytics.purged']) {
      expect(CORE_EVENTS).toContain(name);
    }
  });

  it('#18 公開する入口から PluginPublisherConflictError が取れる', () => {
    expect(publicApi.PluginPublisherConflictError).toBeTypeOf('function');
  });
});
