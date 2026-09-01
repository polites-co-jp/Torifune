import { describe, expect, it } from 'vitest';
import {
  isFetchableUrl,
  parseRegistryIndex,
  registryUrl,
  RegistryError,
  searchEntries,
  type RegistryEntry,
} from './registry-client';

/**
 * Registry クライアント（03_プラグイン設計.md §14.1 §15、020-plugin-registry 設計 §2.1）。
 *
 * 取得（fetch）と解釈を分けてあるので、解釈だけをここで確かめる。
 */

function entry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'com.example.seo',
    name: 'SEO レポート',
    version: '1.0.0',
    downloadUrl: 'https://example.com/seo-1.0.0.zip',
    sha256: 'abc123',
    signature: 'c2ln',
    publisher: 'example.com',
    ...overrides,
  };
}

describe('registryUrl', () => {
  it('未設定なら null', () => {
    expect(registryUrl({})).toBeNull();
    expect(registryUrl({ TORIFUNE_PLUGIN_REGISTRY_URL: '  ' })).toBeNull();
  });

  it('設定されていれば返す', () => {
    expect(registryUrl({ TORIFUNE_PLUGIN_REGISTRY_URL: 'https://r.example.com/index.json' })).toBe(
      'https://r.example.com/index.json',
    );
  });
});

describe('isFetchableUrl', () => {
  it('https を許す', () => {
    expect(isFetchableUrl('https://example.com/a.json')).toBe(true);
  });

  /**
   * HTTP だと配布物を途中で差し替えられる。署名で改竄は検出できるが、
   * 署名の無いものを掴まされる余地を残さない。
   */
  it('http を許さない', () => {
    expect(isFetchableUrl('http://example.com/a.json')).toBe(false);
  });

  it('開発用の localhost だけ http を許す', () => {
    expect(isFetchableUrl('http://localhost:8080/a.json')).toBe(true);
    expect(isFetchableUrl('http://127.0.0.1:8080/a.json')).toBe(true);
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a url', ''])(
    '危険・不正な URL を許さない: %s',
    (value) => {
      expect(isFetchableUrl(value)).toBe(false);
    },
  );
});

describe('parseRegistryIndex', () => {
  it('項目を読む', () => {
    const entries = parseRegistryIndex({ plugins: [entry()] });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('com.example.seo');
    expect(entries[0]?.publisher).toBe('example.com');
  });

  it.each([null, 'text', 42, {}, { plugins: 'no' }])('形式が不正なら失敗する: %s', (payload) => {
    expect(() => parseRegistryIndex(payload)).toThrow(RegistryError);
  });

  /** 1件の不備で全体を捨てない。残りは使える。 */
  it.each([
    ['id が無い', { id: undefined }],
    ['署名が無い', { signature: undefined }],
    ['checksum が無い', { sha256: undefined }],
    ['配布URLが http', { downloadUrl: 'http://example.com/a.zip' }],
    ['配布URLが file', { downloadUrl: 'file:///tmp/a.zip' }],
  ])('壊れた項目だけを落とす: %s', (_label, overrides) => {
    const entries = parseRegistryIndex({
      plugins: [entry(overrides as Record<string, unknown>), entry({ id: 'com.example.ok' })],
    });

    expect(entries.map((e) => e.id)).toEqual(['com.example.ok']);
  });

  it('説明と配布元は無くてもよい', () => {
    const entries = parseRegistryIndex({
      plugins: [entry({ description: undefined, publisher: undefined })],
    });
    expect(entries[0]?.description).toBeNull();
    expect(entries[0]?.publisher).toBeNull();
  });

  /**
   * 03_プラグイン設計.md §15 が Registry に保持を求める項目。
   *
   * **これらが無いと、zip を落として展開するまで互換性・依存を判断できない。**
   * 判断できないまま導入させると、入れてから壊れる。
   */
  describe('仕様 §15 の保持項目', () => {
    it('Plugin API Version・依存関係・対応Torifune Version・更新日時を読む', () => {
      const entries = parseRegistryIndex({
        plugins: [
          entry({
            apiVersion: 1,
            dependencies: { 'base-plugin': '^1.2.0' },
            torifuneVersion: '^1.0.0',
            updatedAt: '2026-02-01T00:00:00.000Z',
            permissions: ['site.read'],
          }),
        ],
      });

      expect(entries[0]?.apiVersion).toBe(1);
      expect(entries[0]?.dependencies).toEqual({ 'base-plugin': '^1.2.0' });
      expect(entries[0]?.torifuneVersion).toBe('^1.0.0');
      expect(entries[0]?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
      expect(entries[0]?.permissions).toEqual(['site.read']);
    });

    /** 既存の Registry を壊さない。宣言していないものは「不明」として扱う。 */
    it('宣言が無ければ不明として読む', () => {
      const entries = parseRegistryIndex({ plugins: [entry()] });

      expect(entries[0]?.apiVersion).toBeNull();
      expect(entries[0]?.dependencies).toEqual({});
      expect(entries[0]?.torifuneVersion).toBeNull();
      expect(entries[0]?.updatedAt).toBeNull();
      // 「要求しない」と「宣言していない」を混ぜない。
      expect(entries[0]?.permissions).toBeNull();
    });

    /**
     * **値があるのに形が違うものは推測しない。**
     * 「不明」に落とすと、合わない Plugin を「判定できないだけ」に見せてしまう。
     */
    it.each([
      ['apiVersion が数値でない', { apiVersion: 'いち' }],
      ['apiVersion が整数でない', { apiVersion: 1.5 }],
      ['依存関係が object でない', { dependencies: ['base-plugin'] }],
      ['依存関係の範囲が文字列でない', { dependencies: { 'base-plugin': 1 } }],
      ['対応Torifune Version が文字列でない', { torifuneVersion: 1 }],
      ['更新日時が日時として読めない', { updatedAt: 'きのう' }],
      ['要求 Permission が配列でない', { permissions: 'site.read' }],
      ['要求 Permission に文字列でないものが混じる', { permissions: ['site.read', 3] }],
    ])('壊れていればその項目だけを落とす: %s', (_label, overrides) => {
      const entries = parseRegistryIndex({
        plugins: [entry(overrides as Record<string, unknown>), entry({ id: 'com.example.ok' })],
      });

      expect(entries.map((e) => e.id)).toEqual(['com.example.ok']);
    });
  });
});

describe('searchEntries', () => {
  const entries = parseRegistryIndex({
    plugins: [
      entry({ id: 'com.example.seo', name: 'SEO レポート', description: '検索順位' }),
      entry({ id: 'com.example.mail', name: 'メール配信', description: null }),
    ],
  }) as readonly RegistryEntry[];

  it('空なら全部返す', () => {
    expect(searchEntries(entries, '  ')).toHaveLength(2);
  });

  it('ID で絞れる', () => {
    expect(searchEntries(entries, 'mail').map((e) => e.id)).toEqual(['com.example.mail']);
  });

  it('名前で絞れる', () => {
    expect(searchEntries(entries, 'レポート').map((e) => e.id)).toEqual(['com.example.seo']);
  });

  it('説明で絞れる', () => {
    expect(searchEntries(entries, '検索順位').map((e) => e.id)).toEqual(['com.example.seo']);
  });

  it('大文字小文字を区別しない', () => {
    expect(searchEntries(entries, 'SEO')).toHaveLength(1);
    expect(searchEntries(entries, 'seo')).toHaveLength(1);
  });
});
